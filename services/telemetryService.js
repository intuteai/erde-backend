// services/telemetryService.js
const db = require('../config/postgres');
const logger = require('../utils/logger');

const toNum = (v) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

const toText = (v) => (v === null || v === undefined ? null : String(v));

/**
 * Ensures array is exactly length N, ordered, no guessing.
 * Pads with null, trims extras.
 */
const normalizeModuleArray = (arr, size = 5) => {
  if (!Array.isArray(arr)) return null;
  const out = new Array(size).fill(null);
  for (let i = 0; i < Math.min(arr.length, size); i++) {
    out[i] = toNum(arr[i]);
  }
  return out;
};

/**
 * Accepts:
 *  - seconds (number)
 *  - ISO duration string
 *  - postgres interval literal
 */
const toInterval = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return `${v} seconds`;
  return String(v);
};

const insertTelemetryItems = async (items = []) => {
  if (!items.length) return { inserted: 0 };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    let inserted = 0;

    for (const item of items) {
      const { ts, vehicleIdOrMasterId, live = {} } = item;

      const cellVoltages = normalizeModuleArray(live.cell_module_avg_v, 5);
      const tempSensors = normalizeModuleArray(live.temp_module_avg_c, 5);

      if (cellVoltages && cellVoltages.length !== 5) {
        logger.warn('cell_voltages array normalized to 5 modules');
      }
      if (tempSensors && tempSensors.length !== 5) {
        logger.warn('temp_sensors array normalized to 5 modules');
      }

      const values = [
        vehicleIdOrMasterId,
        ts,

        // Battery
        toNum(live.soc_percent),
        toNum(live.stack_voltage_v),
        toText(live.battery_status),
        toNum(live.max_voltage_v),
        toNum(live.min_voltage_v),
        toNum(live.avg_voltage_v),
        toNum(live.max_temp_c),
        toNum(live.min_temp_c),
        toNum(live.avg_temp_c),
        toNum(live.battery_current_a),
        toNum(live.charger_current_demand_a),
        toNum(live.charger_voltage_demand_v),

        // Modules
        cellVoltages,
        tempSensors,

        // Motor / MCU
        toNum(live.motor_torque_limit),
        toNum(live.motor_torque_value),
        live.motor_speed_rpm ?? null,
        toText(live.motor_rotation_dir),
        toText(live.motor_operation_mode),
        toText(live.mcu_enable_state),
        toNum(live.motor_ac_current_a),
        toNum(live.motor_ac_voltage_v),
        toNum(live.dc_side_voltage_v),
        toNum(live.motor_temp_c),
        toNum(live.mcu_temp_c),
        toNum(live.radiator_temp_c),

        // ODO / Trip
        toInterval(live.total_running_hrs),
        toInterval(live.last_trip_hrs),
        toNum(live.total_kwh_consumed),
        toNum(live.last_trip_kwh),

        // Alarms
        live.alarms ? JSON.stringify(live.alarms) : JSON.stringify({})
      ];

      await client.query(
        `
        INSERT INTO live_values (
          vehicle_master_id, recorded_at,

          soc_percent, stack_voltage_v, battery_status,
          max_voltage_v, min_voltage_v, avg_voltage_v,
          max_temp_c, min_temp_c, avg_temp_c,
          battery_current_a,
          charger_current_demand_a, charger_voltage_demand_v,

          cell_voltages, temp_sensors,

          motor_torque_limit, motor_torque_value, motor_speed_rpm,
          motor_rotation_dir, motor_operation_mode, mcu_enable_state,
          motor_ac_current_a, motor_ac_voltage_v, dc_side_voltage_v,
          motor_temp_c, mcu_temp_c, radiator_temp_c,

          total_running_hrs, last_trip_hrs,
          total_kwh_consumed, last_trip_kwh,

          alarms
        )
        VALUES (
          $1, to_timestamp($2 / 1000.0),

          $3, $4, $5,
          $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14,

          $15::numeric[], $16::numeric[],

          $17, $18, $19,
          $20, $21, $22,
          $23, $24, $25,
          $26, $27, $28,

          $29::interval, $30::interval,
          $31, $32,

          $33::jsonb
        )
        `,
        values
      );

      inserted++;
    }

    await client.query('COMMIT');
    return { inserted };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Telemetry insert failed:', err);
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { insertTelemetryItems };
