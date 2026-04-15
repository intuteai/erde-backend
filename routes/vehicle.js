// routes/vehicle.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter, liveRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const { formatLiveData } = require('../utils/formatLiveData');
const {
  liveCache,
  cleanupLiveCache,
  LIVE_CACHE_TTL_MS,
} = require('../services/liveCache');

const router = express.Router();

/* =========================
   SHARED HELPERS
========================= */

/**
 * Parses and validates a route :id param.
 * Returns a positive integer or null.
 */
const parseVehicleId = (raw) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Checks whether the authenticated user may access a given vehicle.
 * Admins (non-customer role) always pass.
 * Customers are restricted to vehicles under their user_id.
 * Returns true/false.
 */
const checkVehicleAccess = async (vehicleId, userId, isCustomer) => {
  const result = await db.query(
    `
    SELECT EXISTS(
      SELECT 1
      FROM vehicle_master vm
      JOIN customer_master cm ON vm.customer_id = cm.customer_id
      WHERE vm.vehicle_master_id = $1
        AND ($2::int IS NULL OR cm.user_id = $2)
    ) AS allowed
    `,
    [vehicleId, isCustomer ? userId : null]
  );
  return result.rows[0]?.allowed === true;
};

/**
 * Converts a Postgres interval object returned by node-postgres
 * into decimal hours.
 */
const intervalToHours = (interval) => {
  if (!interval) return null;
  const { days = 0, hours = 0, minutes = 0, seconds = 0 } = interval;
  return days * 24 + hours + minutes / 60 + seconds / 3600;
};

/**
 * Coerces a value to a finite number or null.
 */
const toNumber = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* =========================
   Cache maintenance on a timer — NOT on every request.
   Doing it per-request adds unnecessary overhead on hot endpoints.
========================= */
setInterval(cleanupLiveCache, 60_000);

/* ============================================================
   GET /api/vehicles — List accessible vehicles
============================================================ */
router.get(
  '/',
  authenticateToken,
  generalLimiter,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    try {
      const isCustomer = req.user.role === 'customer';
      const result = await db.query(
        `
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_unique_id,
          vm.vehicle_reg_no,
          vm.vehicle_type,
          cm.company_name,
          vt.make,
          vt.model,
          vm.vcu_make_model,
          vm.hmi_make_model,
          vm.date_of_deployment
        FROM vehicle_master vm
        JOIN customer_master cm     ON vm.customer_id = cm.customer_id
        JOIN vehicle_type_master vt ON vm.vtype_id    = vt.vtype_id
        WHERE ($1::int IS NULL OR cm.user_id = $1)
        ORDER BY vm.vehicle_unique_id
        `,
        [isCustomer ? req.user.user_id : null]
      );
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /vehicles error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/analytics/batch
   ?mode=today  OR  ?from=YYYY-MM-DD&to=YYYY-MM-DD

   Returns analytics for ALL accessible vehicles in ONE query.
   Replaces N individual /analytics calls from the dashboard.

   MUST be defined before /:id routes so Express does not
   treat the literal string "analytics" as a vehicle :id.
============================================================ */
router.get(
  '/analytics/batch',
  authenticateToken,
  generalLimiter,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    const { mode, from, to } = req.query;
    const isCustomer = req.user.role === 'customer';

    // 1. Resolve IST-safe time range
    const toISTStart = (d) => new Date(`${d}T00:00:00+05:30`);
    const toISTEnd   = (d) => new Date(`${d}T23:59:59.999+05:30`);

    let startTime, endTime;

    if (mode === 'today') {
      const todayIST = new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kolkata',
      });
      startTime = toISTStart(todayIST);
      endTime   = new Date();
    } else if (from && to) {
      startTime = toISTStart(from);
      endTime   = toISTEnd(to);
    } else {
      return res.status(400).json({
        error: 'Use mode=today OR from=YYYY-MM-DD&to=YYYY-MM-DD',
      });
    }

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return res.status(400).json({ error: 'Invalid date format (use YYYY-MM-DD)' });
    }
    if (startTime > endTime) {
      return res.status(400).json({ error: 'Start date cannot be after end date' });
    }

    try {
      // 2. Get all vehicle IDs this user can access
      const vehicleRes = await db.query(
        `
        SELECT vm.vehicle_master_id
        FROM vehicle_master vm
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        WHERE ($1::int IS NULL OR cm.user_id = $1)
        `,
        [isCustomer ? req.user.user_id : null]
      );

      if (!vehicleRes.rows.length) return res.json({});

      const vehicleIds = vehicleRes.rows.map(r => r.vehicle_master_id);

      // 3. LATERAL join — one index seek per vehicle using idx_live.
      //
      //    baseline_row: the last record BEFORE the window opens.
      //      This is the odometer reading at the start of the period.
      //      Using the record just before (not just after) the window
      //      correctly handles the case where a vehicle was already
      //      running before the window start (e.g. today at midnight).
      //
      //    last_row: the last record inside the window.
      //      Delta = last_row - baseline_row gives the period's usage.
      //
      //    Why not first record inside the window?
      //      If a vehicle starts the day with total_running_hrs = 10.5
      //      and the first telemetry of the day arrives at 08:00 with
      //      total_running_hrs = 10.5, the delta would be 0 — correct.
      //      But if no record lands exactly at window start, the first
      //      record inside the window might already have accumulated time,
      //      causing the delta to be understated. The pre-window baseline
      //      is always the most accurate reference point.
      const rangeRes = await db.query(
        `
        SELECT
          v.vehicle_master_id,
          baseline_row.total_running_hrs  AS first_running_hrs,
          baseline_row.total_kwh_consumed AS first_kwh,
          last_row.total_running_hrs      AS last_running_hrs,
          last_row.total_kwh_consumed     AS last_kwh
        FROM unnest($1::int[]) AS v(vehicle_master_id)

        -- Baseline: last record strictly BEFORE the window opens
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

      // 4. Compute deltas per vehicle
      const intervalToHoursLocal = (interval) => {
        if (!interval) return 0;
        const { days = 0, hours = 0, minutes = 0, seconds = 0 } = interval;
        return days * 24 + hours + minutes / 60 + seconds / 3600;
      };

      const map = {};

      for (const row of rangeRes.rows) {
        const firstHours   = intervalToHoursLocal(row.first_running_hrs);
        const lastHours    = intervalToHoursLocal(row.last_running_hrs);
        const runningHours = Number(Math.max(0, lastHours - firstHours).toFixed(2));

        const firstKwh = row.first_kwh !== null ? Number(row.first_kwh) : null;
        const lastKwh  = row.last_kwh  !== null ? Number(row.last_kwh)  : null;
        const kwhConsumed =
          firstKwh !== null && lastKwh !== null
            ? Number(Math.max(0, lastKwh - firstKwh).toFixed(2))
            : 0;

        const avgKwh = runningHours > 0
          ? Number((kwhConsumed / runningHours).toFixed(2))
          : null;

        map[row.vehicle_master_id] = {
          vehicle_master_id: row.vehicle_master_id,
          running_hours: runningHours,
          kwh_consumed:  kwhConsumed,
          avg_kwh:       avgKwh,
        };
      }

      // Vehicles with no data in range return zeros
      for (const id of vehicleIds) {
        if (!map[id]) {
          map[id] = {
            vehicle_master_id: id,
            running_hours: 0,
            kwh_consumed:  0,
            avg_kwh:       null,
          };
        }
      }

      res.json(map);
    } catch (err) {
      logger.error(`GET /vehicles/analytics/batch error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id — Vehicle summary + latest ODO/kWh
============================================================ */
router.get(
  '/:id',
  authenticateToken,
  generalLimiter,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    const id = parseVehicleId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid vehicle ID' });

    const isCustomer = req.user.role === 'customer';
    try {
      const result = await db.query(
        `
        WITH vehicle_info AS (
          SELECT
            vm.vehicle_master_id,
            vm.vehicle_reg_no,
            cm.company_name,
            vt.make,
            vt.model,
            vm.date_of_deployment
          FROM vehicle_master vm
          JOIN customer_master cm     ON vm.customer_id = cm.customer_id
          JOIN vehicle_type_master vt ON vm.vtype_id    = vt.vtype_id
          WHERE vm.vehicle_master_id = $1
            AND ($2::int IS NULL OR cm.user_id = $2)
        ),
        latest_live AS (
          SELECT total_running_hrs, total_kwh_consumed
          FROM live_values
          WHERE vehicle_master_id = $1
          ORDER BY recorded_at DESC
          LIMIT 1
        )
        SELECT vi.*, ll.total_running_hrs, ll.total_kwh_consumed
        FROM vehicle_info vi
        LEFT JOIN latest_live ll ON true
        `,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'Vehicle not found or access denied' });
      }

      const row = result.rows[0];

      res.json({
        vehicle_master_id: row.vehicle_master_id,
        company_name:      row.company_name,
        make:              row.make,
        model:             row.model,
        vehicle_reg_no:    row.vehicle_reg_no,
        total_hours:       toNumber(intervalToHours(row.total_running_hrs)),
        total_kwh:         toNumber(row.total_kwh_consumed),
        date_of_deployment: row.date_of_deployment,
      });
    } catch (err) {
      logger.error(`GET /vehicles/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/live — Cached live snapshot
============================================================ */
router.get(
  '/:id/live',
  authenticateToken,
  checkPermission('live_view', 'read'),
  liveRateLimiter,
  async (req, res) => {
    const id = parseVehicleId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid vehicle ID' });

    const isCustomer = req.user.role === 'customer';
    const cacheKey   = `vehicle_live:${id}`;
    const now        = Date.now();

    try {
      // --- Fast path: serve from cache ---
      let entry = liveCache.get(cacheKey);
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      // --- Ownership check ---
      const allowed = await checkVehicleAccess(id, req.user.user_id, isCustomer);
      if (!allowed) return res.json({});

      // --- Re-check cache: another concurrent request may have populated it
      //     while we were waiting on the ownership query ---
      entry = liveCache.get(cacheKey);
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      // --- In-flight deduplication: attach to an existing DB fetch
      //     rather than spawning a second parallel query for the same vehicle ---
      if (entry?.inflight) {
        try {
          const data = await Promise.race([
            entry.inflight,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Inflight timeout')), 5000)
            ),
          ]);
          return res.json(data);
        } catch {
          // timed out — fall through to a fresh fetch
        }
      }

      // --- Fresh DB fetch ---
      const inflightPromise = (async () => {
        try {
          const result = await db.query(
            `
            SELECT *
            FROM live_values
            WHERE vehicle_master_id = $1
            ORDER BY recorded_at DESC
            LIMIT 1
            `,
            [id]
          );
          if (!result.rows.length) return {};
          return formatLiveData(result.rows[0]);
        } catch (err) {
          logger.error(`Live fetch error for vehicle ${id}: ${err.message}`);
          return {};
        }
      })();

      liveCache.set(cacheKey, { ts: now, inflight: inflightPromise });
      const data = await inflightPromise;
      liveCache.set(cacheKey, { ts: Date.now(), data });

      res.json(data);
    } catch (err) {
      logger.error(`Unexpected /live error for vehicle ${id}: ${err.message}`);
      res.json({});
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/timeseries?minutes=5
   Returns recent rows for charting.
   Anchors to MAX(recorded_at) in the table — immune to
   DB/Node clock skew on cloud deployments.
============================================================ */
router.get(
  '/:id/timeseries',
  authenticateToken,
  generalLimiter,
  checkPermission('live_view', 'read'),
  async (req, res) => {
    const id = parseVehicleId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid vehicle ID' });

    const isCustomer = req.user.role === 'customer';

    // Clamp minutes between 1 and 60 to prevent abuse
    const rawMinutes = parseInt(req.query.minutes ?? '5', 10);
    const minutes    = Number.isFinite(rawMinutes)
      ? Math.min(Math.max(rawMinutes, 1), 60)
      : 5;

    try {
      const allowed = await checkVehicleAccess(id, req.user.user_id, isCustomer);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });

      const anchorRes = await db.query(
        `SELECT MAX(recorded_at) AS latest FROM live_values WHERE vehicle_master_id = $1`,
        [id]
      );

      const latest = anchorRes.rows[0]?.latest;
      if (!latest) {
        logger.info(`Timeseries vehicle=${id}: no data in table`);
        return res.json([]);
      }

      const result = await db.query(
        `
        SELECT
          recorded_at,
          CASE
            WHEN stack_voltage_v IS NOT NULL AND battery_current_a IS NOT NULL
            THEN ROUND((stack_voltage_v * ABS(battery_current_a)) / 1000.0, 4)
            ELSE NULL
          END               AS output_power_kw,
          motor_speed_rpm,
          motor_torque_value AS motor_torque_nm,
          battery_current_a  AS dc_current_a,
          motor_ac_current_a AS ac_current_a,
          motor_ac_voltage_v AS ac_voltage_v
        FROM live_values
        WHERE vehicle_master_id = $1
          AND recorded_at >= $2::timestamptz - (INTERVAL '1 minute' * $3)
          AND recorded_at <= $2::timestamptz
        ORDER BY recorded_at ASC
        LIMIT 300
        `,
        [id, latest, minutes]
      );

      logger.info(
        `Timeseries vehicle=${id}: ${result.rows.length} rows anchored to ${latest}`
      );
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /vehicles/${id}/timeseries error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/analytics
   Supports: mode=today  OR  from=YYYY-MM-DD&to=YYYY-MM-DD
   All times interpreted in IST (Asia/Kolkata, UTC+5:30).
   First and last valid records fetched in ONE query to save
   a DB round-trip vs the original two-query approach.
============================================================ */
router.get(
  '/:id/analytics',
  authenticateToken,
  generalLimiter,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    const id = parseVehicleId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid vehicle ID' });

    const { mode, from, to } = req.query;
    const isCustomer = req.user.role === 'customer';

    try {
      // 1. Ownership
      const allowed = await checkVehicleAccess(id, req.user.user_id, isCustomer);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });

      // 2. Resolve IST-safe time range
      const toISTStart = (d) => new Date(`${d}T00:00:00+05:30`);
      const toISTEnd   = (d) => new Date(`${d}T23:59:59.999+05:30`);

      let startTime, endTime;

      if (mode === 'today') {
        const todayIST = new Date().toLocaleDateString('en-CA', {
          timeZone: 'Asia/Kolkata',
        });
        startTime = toISTStart(todayIST);
        endTime   = new Date();
      } else if (from && to) {
        startTime = toISTStart(from);
        endTime   = toISTEnd(to);
      } else {
        return res.status(400).json({
          error: 'Invalid request. Use mode=today OR from=YYYY-MM-DD&to=YYYY-MM-DD',
        });
      }

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        return res.status(400).json({ error: 'Invalid date format (use YYYY-MM-DD)' });
      }
      if (startTime > endTime) {
        return res.status(400).json({ error: 'Start date cannot be after end date' });
      }

      // 3. Baseline + last record in one query.
      //    baseline: last record BEFORE window opens — the odometer value
      //    at period start, regardless of when the first packet of the day arrives.
      //    last: last record inside the window.
      //    Delta = last - baseline = usage during the period.
      const rangeRes = await db.query(
        `
        (
          SELECT total_running_hrs, total_kwh_consumed, 'baseline' AS _pos
          FROM live_values
          WHERE vehicle_master_id = $1
            AND recorded_at < $2
            AND total_running_hrs  IS NOT NULL
            AND total_kwh_consumed IS NOT NULL
          ORDER BY recorded_at DESC
          LIMIT 1
        )
        UNION ALL
        (
          SELECT total_running_hrs, total_kwh_consumed, 'last' AS _pos
          FROM live_values
          WHERE vehicle_master_id = $1
            AND recorded_at >= $2
            AND recorded_at <= $3
            AND total_running_hrs  IS NOT NULL
            AND total_kwh_consumed IS NOT NULL
          ORDER BY recorded_at DESC
          LIMIT 1
        )
        `,
        [id, startTime, endTime]
      );

      const firstRow = rangeRes.rows.find(r => r._pos === 'baseline');
      const lastRow  = rangeRes.rows.find(r => r._pos === 'last');

      const emptyResponse = {
        vehicle_master_id: id,
        mode:  mode === 'today' ? 'today' : 'custom',
        from:  startTime.toISOString(),
        to:    endTime.toISOString(),
        running_hours: 0,
        kwh_consumed:  0,
        avg_kwh:       null,
      };

      if (!lastRow) return res.json(emptyResponse);

      // 4. Compute deltas
      const firstHours = intervalToHours(firstRow?.total_running_hrs) ?? 0;
      const lastHours  = intervalToHours(lastRow.total_running_hrs)   ?? 0;

      if (lastHours === 0 && firstHours === 0) return res.json(emptyResponse);

      const runningHours = Math.max(0, lastHours - firstHours);
      const kwhConsumed  =
        lastRow.total_kwh_consumed !== null &&
        (firstRow?.total_kwh_consumed ?? null) !== null
          ? Math.max(
              0,
              Number(lastRow.total_kwh_consumed) - Number(firstRow.total_kwh_consumed)
            )
          : 0;

      const avgKwh = runningHours > 0
        ? Number((kwhConsumed / runningHours).toFixed(2))
        : null;

      res.json({
        vehicle_master_id: id,
        mode:          mode === 'today' ? 'today' : 'custom',
        from:          startTime.toISOString(),
        to:            endTime.toISOString(),
        running_hours: Number(runningHours.toFixed(2)),
        kwh_consumed:  Number(kwhConsumed.toFixed(2)),
        avg_kwh:       avgKwh,
      });
    } catch (err) {
      logger.error(`GET /vehicles/${id}/analytics error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/activity?date=YYYY-MM-DD

   Returns 5-minute bucketed activity data for a single day.
   Used by the ActivityTimeline component in LiveCharts.jsx.

   Each bucket contains:
     - bucket:    ISO timestamp of the 5-min slot start (IST)
     - hrs_start: EPOCH seconds of total_running_hrs at bucket start
     - hrs_end:   EPOCH seconds of total_running_hrs at bucket end
     - row_count: number of telemetry rows in this bucket

   Frontend derives state per bucket:
     - hrs_end > hrs_start  → RUNNING  (odometer moved)
     - hrs_end === hrs_start → IDLE    (ECU on, odometer frozen)
     - bucket missing        → OFFLINE (no data = vehicle off)

   Summary stats (running_hours, idle_hours, sessions) are
   computed server-side and returned alongside the buckets.

   All times interpreted in IST (Asia/Kolkata, UTC+5:30).
   Uses existing idx_live index — no new index needed.
   Returns max 288 rows (288 × 5 min = 24 hours).
============================================================ */
router.get(
  '/:id/activity',
  authenticateToken,
  generalLimiter,
  checkPermission('live_view', 'read'),
  async (req, res) => {
    const id = parseVehicleId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid vehicle ID' });

    const { date } = req.query;

    // Validate date param — must be YYYY-MM-DD
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date param required (YYYY-MM-DD)' });
    }

    // Reject future dates
    const todayIST = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    if (date > todayIST) {
      return res.status(400).json({ error: 'date cannot be in the future' });
    }

    const isCustomer = req.user.role === 'customer';

    try {
      // 1. Ownership check
      const allowed = await checkVehicleAccess(id, req.user.user_id, isCustomer);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });

      // 2. Build IST day boundaries
      //    e.g. date=2026-04-14
      //      → startTime = 2026-04-14T00:00:00+05:30
      //      → endTime   = 2026-04-14T23:59:59.999+05:30
      const startTime = new Date(`${date}T00:00:00+05:30`);
      const endTime   = new Date(`${date}T23:59:59.999+05:30`);

      if (isNaN(startTime.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
      }

      // 3. Bucket into 5-minute IST-aligned slots in Postgres.
      //
      //    date_trunc('hour') + FLOOR(minute/5)*5min groups rows into
      //    5-min windows that align to IST clock hours (not UTC hours).
      //
      //    MIN/MAX of EXTRACT(EPOCH FROM total_running_hrs) gives the
      //    odometer value in seconds at the start and end of each bucket.
      //      MAX > MIN  → odometer moved        → RUNNING
      //      MAX = MIN  → odometer frozen        → IDLE
      //      No bucket  → no ECU data at all     → OFFLINE
      //
      //    AT TIME ZONE 'Asia/Kolkata' ensures 5-min boundaries align
      //    to IST midnight, not UTC midnight.
      const result = await db.query(
        `
        SELECT
          date_trunc('hour', recorded_at AT TIME ZONE 'Asia/Kolkata')
            + (FLOOR(EXTRACT(MINUTE FROM recorded_at AT TIME ZONE 'Asia/Kolkata') / 5)
               * INTERVAL '5 minutes')
            AS bucket_ist,
          MIN(EXTRACT(EPOCH FROM total_running_hrs))::float AS hrs_start,
          MAX(EXTRACT(EPOCH FROM total_running_hrs))::float AS hrs_end,
          COUNT(*)::int                                      AS row_count
        FROM live_values
        WHERE vehicle_master_id = $1
          AND recorded_at >= $2
          AND recorded_at <= $3
          AND total_running_hrs IS NOT NULL
        GROUP BY bucket_ist
        ORDER BY bucket_ist ASC
        `,
        [id, startTime, endTime]
      );

      // 4. Compute summary stats server-side.
      //
      //    running_seconds: sum of actual odometer delta per bucket.
      //      This is the real work time — not an estimate.
      //
      //    idle_seconds: approximated as 5 min per idle bucket.
      //      We know the ECU was on (rows exist) but the odometer
      //      didn't move. 5 min per bucket is a safe upper bound.
      //
      //    sessions: count of contiguous RUNNING sequences.
      //      A new session starts whenever a running bucket follows
      //      a non-running bucket (idle or offline gap).
      let runningSeconds = 0;
      let idleSeconds    = 0;
      let sessions       = 0;
      let lastWasRunning = false;

      for (const row of result.rows) {
        const delta = row.hrs_end - row.hrs_start; // seconds (EPOCH diff)
        if (delta > 0) {
          runningSeconds += delta;
          if (!lastWasRunning) sessions++;
          lastWasRunning = true;
        } else {
          // Idle: bucket has data but odometer didn't move.
          // Approximate idle time as 5 min per bucket.
          idleSeconds   += 5 * 60;
          lastWasRunning = false;
        }
      }

      // 5. Shape response
      logger.info(
        `Activity vehicle=${id} date=${date}: ${result.rows.length} buckets, ` +
        `${(runningSeconds / 3600).toFixed(2)}h running, ${sessions} sessions`
      );

      res.json({
        date,
        buckets: result.rows.map((row) => ({
          // ISO string of bucket start — frontend parses this into IST time
          bucket:    new Date(row.bucket_ist).toISOString(),
          hrs_start: row.hrs_start,
          hrs_end:   row.hrs_end,
          row_count: row.row_count,
        })),
        summary: {
          running_hours:           Number((runningSeconds / 3600).toFixed(2)),
          idle_hours:              Number((idleSeconds    / 3600).toFixed(2)),
          sessions,
          total_buckets_with_data: result.rows.length,
        },
      });
    } catch (err) {
      logger.error(`GET /vehicles/${id}/activity error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/stream — SSE live stream
   Pushes a fresh data frame every second.
   Uses liveCache to share DB fetches across concurrent clients
   watching the same vehicle.
============================================================ */
router.get(
  '/:id/stream',
  authenticateToken,
  checkPermission('live_view', 'read'),
  liveRateLimiter,
  async (req, res) => {
    const id = parseVehicleId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid vehicle ID' });

    const user       = req.user;
    const isCustomer = user.role === 'customer';

    // Ownership check before opening the long-lived connection
    try {
      const allowed = await checkVehicleAccess(id, user.user_id, isCustomer);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });
    } catch (err) {
      logger.warn(`SSE ownership check failed for vehicle ${id}: ${err.message}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',        // disable Nginx buffering
    });

    res.flushHeaders();

    logger.info(`SSE connected → user=${user.email}, vehicle=${id}`);

    const cacheKey = `vehicle_live:${id}`;

    // Push cached snapshot immediately so the client has data right away
    const initial = liveCache.get(cacheKey);
    if (initial?.data && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(initial.data)}\n\n`);
    }

    let missedUpdates = 0;

    const interval = setInterval(async () => {
      if (res.writableEnded) {
        clearInterval(interval);
        return;
      }

      try {
        const now     = Date.now();
        let   current = liveCache.get(cacheKey);

        // --- Cache hit ---
        if (current?.data && now - current.ts < LIVE_CACHE_TTL_MS) {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(current.data)}\n\n`);
          missedUpdates = 0;
          return;
        }

        // --- Start a new fetch if none is already in-flight ---
        if (!current?.inflight) {
          const inflightPromise = (async () => {
            try {
              const result = await db.query(
                `
                SELECT *
                FROM live_values
                WHERE vehicle_master_id = $1
                ORDER BY recorded_at DESC
                LIMIT 1
                `,
                [id]
              );
              if (!result.rows.length) return {};
              return formatLiveData(result.rows[0]);
            } catch (err) {
              logger.error(`SSE fetch error for vehicle ${id}: ${err.message}`);
              return {};
            }
          })();

          liveCache.set(cacheKey, { ts: now, inflight: inflightPromise });
          current = { ts: now, inflight: inflightPromise };
        }

        // --- Wait for the in-flight fetch (ours or someone else's) ---
        try {
          const data = await Promise.race([
            current.inflight,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Fetch timeout')), 5000)
            ),
          ]);

          liveCache.set(cacheKey, { ts: Date.now(), data });

          if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
          missedUpdates = 0;
        } catch {
          missedUpdates++;
          if (missedUpdates > 5) {
            logger.warn(
              `Too many missed updates (${missedUpdates}) → closing SSE for vehicle ${id}`
            );
            if (!res.writableEnded) res.end();
            clearInterval(interval);
          }
        }
      } catch (err) {
        logger.error(`SSE interval error for vehicle ${id}: ${err.message}`);
      }
    }, 1000);

    // Heartbeat keeps the connection alive through proxies and load balancers
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(':\n\n');
      } catch {
        clearInterval(heartbeat);
        clearInterval(interval);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(interval);
      clearInterval(heartbeat);
      logger.info(`SSE disconnected → vehicle=${id}`);
    });

    res.on('error', (err) => {
      logger.error(`SSE response error for vehicle ${id}: ${err.message}`);
      clearInterval(interval);
      clearInterval(heartbeat);
    });
  }
);

module.exports = router;