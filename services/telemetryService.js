// services/telemetryService.js
const db = require('../config/postgres');
const logger = require('../utils/logger');

const toNum = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const toText = (v) => (v === null || v === undefined ? null : String(v));
const arrOrNull = (a) => (Array.isArray(a) && a.length ? a : null);

const insertTelemetryItems = async (items = []) => {
  if (!items.length) return { inserted: 0 };

  const client = await db.getClient(); // Use transaction
  try {
    await client.query('BEGIN');

    let inserted = 0;
    for (const item of items) {
      const { ts, vehicleIdOrMasterId, live = {} } = item;

      const values = [
        vehicleIdOrMasterId,
        ts,
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
        arrOrNull(live.cell_module_avg_v),
        arrOrNull(live.temp_module_avg_c),
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
          alarms
        )
        VALUES (
          $1, to_timestamp($2/1000.0),
          $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15::numeric[], $16::numeric[], $17, $18, $19, $20, $21, $22,
          $23, $24, $25, $26, $27, $28, $29::jsonb
        )
        ON CONFLICT (vehicle_master_id) DO UPDATE SET
          recorded_at = EXCLUDED.recorded_at,
          soc_percent = EXCLUDED.soc_percent,
          stack_voltage_v = EXCLUDED.stack_voltage_v,
          battery_status = EXCLUDED.battery_status,
          max_voltage_v = EXCLUDED.max_voltage_v,
          min_voltage_v = EXCLUDED.min_voltage_v,
          avg_voltage_v = EXCLUDED.avg_voltage_v,
          max_temp_c = EXCLUDED.max_temp_c,
          min_temp_c = EXCLUDED.min_temp_c,
          avg_temp_c = EXCLUDED.avg_temp_c,
          battery_current_a = EXCLUDED.battery_current_a,
          charger_current_demand_a = EXCLUDED.charger_current_demand_a,
          charger_voltage_demand_v = EXCLUDED.charger_voltage_demand_v,
          cell_voltages = EXCLUDED.cell_voltages,
          temp_sensors = EXCLUDED.temp_sensors,
          motor_torque_limit = EXCLUDED.motor_torque_limit,
          motor_torque_value = EXCLUDED.motor_torque_value,
          motor_speed_rpm = EXCLUDED.motor_speed_rpm,
          motor_rotation_dir = EXCLUDED.motor_rotation_dir,
          motor_operation_mode = EXCLUDED.motor_operation_mode,
          mcu_enable_state = EXCLUDED.mcu_enable_state,
          motor_ac_current_a = EXCLUDED.motor_ac_current_a,
          motor_ac_voltage_v = EXCLUDED.motor_ac_voltage_v,
          dc_side_voltage_v = EXCLUDED.dc_side_voltage_v,
          motor_temp_c = EXCLUDED.motor_temp_c,
          mcu_temp_c = EXCLUDED.mcu_temp_c,
          radiator_temp_c = EXCLUDED.radiator_temp_c,
          alarms = EXCLUDED.alarms
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