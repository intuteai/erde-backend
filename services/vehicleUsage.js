// services/vehicleUsage.js
// Usage in a date range, from the cumulative hours and kWh counters.
const db = require('../config/postgres');

const intervalToHours = (interval) => {
  if (!interval) return 0;
  const { days = 0, hours = 0, minutes = 0, seconds = 0 } = interval;
  return days * 24 + hours + minutes / 60 + seconds / 3600;
};

/**
 * Usage = last reading in the range - the counters at the start of the range.
 *
 * The start is the last reading BEFORE the range: the first reading inside it
 * may already have accumulated time. A machine launched during the range has no
 * such reading, so its first reading inside the range is the start instead.
 *
 * Counters that go backwards report 0 rather than negative usage.
 *
 * @param {{ baseline: ?object, firstInRange: ?object, last: ?object }} readings
 *   each reading has total_running_hrs (pg interval) and total_kwh_consumed
 * @returns {{ running_hours: number, kwh_consumed: number, avg_kwh: ?number }}
 */
const computeUsage = ({ baseline, firstInRange, last }) => {
  const start = baseline ?? firstInRange;
  if (!last || !start) return { running_hours: 0, kwh_consumed: 0, avg_kwh: null };

  const hours = Math.max(0, intervalToHours(last.total_running_hrs) - intervalToHours(start.total_running_hrs));
  const kwh = Math.max(0, Number(last.total_kwh_consumed) - Number(start.total_kwh_consumed));

  return {
    running_hours: Number(hours.toFixed(2)),
    kwh_consumed: Number(kwh.toFixed(2)),
    avg_kwh: hours > 0 ? Number((kwh / hours).toFixed(2)) : null,
  };
};

// A LEFT JOIN that found nothing gives NULL in both columns.
const toReading = (total_running_hrs, total_kwh_consumed) =>
  (total_running_hrs === null && total_kwh_consumed === null
    ? null
    : { total_running_hrs, total_kwh_consumed });

/**
 * Usage for several vehicles in ONE query: one index seek per vehicle per reading.
 * first_row only runs for vehicles with no baseline.
 *
 * @returns {Promise<Object>} { [vehicle_master_id]: { vehicle_master_id, running_hours, kwh_consumed, avg_kwh } }
 */
const fetchVehicleUsage = async (vehicleIds, startTime, endTime) => {
  const { rows } = await db.query(
    `
    SELECT
      v.vehicle_master_id,
      baseline_row.total_running_hrs  AS baseline_hrs,
      baseline_row.total_kwh_consumed AS baseline_kwh,
      first_row.total_running_hrs     AS first_hrs,
      first_row.total_kwh_consumed    AS first_kwh,
      last_row.total_running_hrs      AS last_hrs,
      last_row.total_kwh_consumed     AS last_kwh
    FROM unnest($1::int[]) AS v(vehicle_master_id)

    -- Last record strictly BEFORE the window opens
    LEFT JOIN LATERAL (
      SELECT total_running_hrs, total_kwh_consumed
      FROM live_values
      WHERE vehicle_master_id = v.vehicle_master_id
        AND recorded_at < $2
        AND total_running_hrs  IS NOT NULL
        AND total_kwh_consumed IS NOT NULL
      ORDER BY recorded_at DESC
      LIMIT 1
    ) baseline_row ON true

    -- First record inside the window, only needed without a baseline
    LEFT JOIN LATERAL (
      SELECT total_running_hrs, total_kwh_consumed
      FROM live_values
      WHERE baseline_row.total_running_hrs IS NULL
        AND vehicle_master_id = v.vehicle_master_id
        AND recorded_at >= $2
        AND recorded_at <= $3
        AND total_running_hrs  IS NOT NULL
        AND total_kwh_consumed IS NOT NULL
      ORDER BY recorded_at ASC
      LIMIT 1
    ) first_row ON true

    -- Last record inside the window
    LEFT JOIN LATERAL (
      SELECT total_running_hrs, total_kwh_consumed
      FROM live_values
      WHERE vehicle_master_id = v.vehicle_master_id
        AND recorded_at >= $2
        AND recorded_at <= $3
        AND total_running_hrs  IS NOT NULL
        AND total_kwh_consumed IS NOT NULL
      ORDER BY recorded_at DESC
      LIMIT 1
    ) last_row ON true
    `,
    [vehicleIds, startTime, endTime]
  );

  const usage = {};
  for (const id of vehicleIds) {
    usage[id] = { vehicle_master_id: id, ...computeUsage({ baseline: null, firstInRange: null, last: null }) };
  }
  for (const row of rows) {
    usage[row.vehicle_master_id] = {
      vehicle_master_id: row.vehicle_master_id,
      ...computeUsage({
        baseline: toReading(row.baseline_hrs, row.baseline_kwh),
        firstInRange: toReading(row.first_hrs, row.first_kwh),
        last: toReading(row.last_hrs, row.last_kwh),
      }),
    };
  }
  return usage;
};

module.exports = { computeUsage, fetchVehicleUsage };
