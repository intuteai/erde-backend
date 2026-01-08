// services/telemetryService.js
const db = require("../config/postgres");
const logger = require("../utils/logger");

/* =========================
   SOCKET.IO INJECTION
========================= */
let io = null;

/**
 * Called once from server.js
 */
const setSocketIO = (socketIO) => {
  io = socketIO;
};

/* =========================
   HELPERS
========================= */
const toNum = (v) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

const toText = (v) => (v === null || v === undefined ? null : String(v));

const normalizeSnapshotArray = (arr, expectedLength) => {
  if (!Array.isArray(arr)) return null;

  const out = new Array(expectedLength).fill(null);

  for (let i = 0; i < Math.min(arr.length, expectedLength); i++) {
    const v = Number(arr[i]);
    out[i] = Number.isFinite(v) ? v : null;
  }

  return out;
};

const toInterval = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return `${v} seconds`;
  return String(v);
};

const TEMP_SENSOR_COUNT = 144;
const CELL_VOLTAGE_COUNT = 192;

/* =========================
   MAIN INSERT FUNCTION
========================= */
const insertTelemetryItems = async (items = []) => {
  if (!items.length) return { inserted: 0 };

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    let inserted = 0;

    for (const item of items) {
      const { ts, live = {} } = item;

      // Extract vehicle_master_id flexibly – matches your TelemetryUploader.ts
      let vehicleMasterId = 
        item.vehicleIdOrMasterId ||
        item.vehicleMasterId ||
        item.vehicle_master_id ||
        item.vehicleId ||
        item.vehicle_id ||
        item.vid ||
        item.deviceId ||
        item.device_id;

      if (!vehicleMasterId) {
        logger.warn("Telemetry item missing vehicle ID – skipping", {
          itemKeys: Object.keys(item),
          sample: item,
        });
        continue;
      }

      vehicleMasterId = Number(vehicleMasterId);
      if (isNaN(vehicleMasterId) || vehicleMasterId <= 0) {
        logger.warn("Invalid vehicle_master_id (not a positive number)", {
          received: item.vehicleIdOrMasterId || item.vehicleMasterId || item.vehicleId,
        });
        continue;
      }

      const tempSensors = normalizeSnapshotArray(
        live.temp_sensors,
        TEMP_SENSOR_COUNT
      );

      const cellVoltages = normalizeSnapshotArray(
        live.cell_voltages,
        CELL_VOLTAGE_COUNT
      );

      const values = [
        vehicleMasterId,
        ts,

        // ================= BATTERY =================
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

        // ================= MODULES =================
        cellVoltages,
        tempSensors,

        // ================= MOTOR / MCU =================
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

        // ================= DCDC =================
        toNum(live.dcdc_pri_a_mosfet_temp_c),
        toNum(live.dcdc_sec_ls_mosfet_temp_c),
        toNum(live.dcdc_sec_hs_mosfet_temp_c),
        toNum(live.dcdc_pri_c_mosfet_temp_c),
        toNum(live.dcdc_input_voltage_v),
        toNum(live.dcdc_input_current_a),
        toNum(live.dcdc_output_voltage_v),
        toNum(live.dcdc_output_current_a),
        live.dcdc_occurence_count ?? null,

        // ================= ODO / ENERGY =================
        toInterval(live.total_running_hrs),
        toInterval(live.last_trip_hrs),
        toNum(live.total_kwh_consumed),
        toNum(live.last_trip_kwh),

        // ================= ALARMS =================
        live.alarms ? JSON.stringify(live.alarms) : JSON.stringify({}),

        // ================= NEW BTMS / BMS THERMAL FIELDS =================
        toNum(live.btms_command_mode),
        toNum(live.btms_hv_request),
        toNum(live.btms_charge_status),
        toNum(live.bms_hv_relay_state),
        toNum(live.btms_target_temp_c),
        toNum(live.bms_pack_voltage_v),
        toNum(live.bms_life_counter),
        toNum(live.btms_command_crc),
        toNum(live.btms_status_mode),
        toNum(live.btms_hv_relay_state),
        toNum(live.btms_inlet_temp_c),
        toNum(live.btms_outlet_temp_c),
        toNum(live.btms_demand_power_kw),

        // ================= NEW MOTOR / INVERTER RAW FIELDS =================
        toNum(live.motor_status_word),
        toNum(live.motor_freq_raw),
        toNum(live.motor_total_wattage_w),
        toNum(live.motor_dc_input_voltage_raw),
        toNum(live.motor_ac_output_voltage_raw),
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
          dcdc_pri_a_mosfet_temp_c,
          dcdc_sec_ls_mosfet_temp_c,
          dcdc_sec_hs_mosfet_temp_c,
          dcdc_pri_c_mosfet_temp_c,
          dcdc_input_voltage_v,
          dcdc_input_current_a,
          dcdc_output_voltage_v,
          dcdc_output_current_a,
          dcdc_occurence_count,
          total_running_hrs, last_trip_hrs,
          total_kwh_consumed, last_trip_kwh,
          alarms,
          btms_command_mode, btms_hv_request, btms_charge_status,
          bms_hv_relay_state, btms_target_temp_c, bms_pack_voltage_v,
          bms_life_counter, btms_command_crc,
          btms_status_mode, btms_hv_relay_state,
          btms_inlet_temp_c, btms_outlet_temp_c, btms_demand_power_kw,
          motor_status_word, motor_freq_raw, motor_total_wattage_w,
          motor_dc_input_voltage_raw, motor_ac_output_voltage_raw
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
          $29, $30, $31, $32,
          $33, $34, $35, $36, $37,
          $38::interval, $39::interval,
          $40, $41,
          $42::jsonb,
          $43, $44, $45, $46, $47, $48, $49, $50,
          $51, $52, $53, $54, $55,
          $56, $57, $58, $59, $60
        )
        `,
        values
      );

      /* =========================
         LIVE SOCKET PUSH (SAFE)
      ========================= */
      if (io) {
        io.to(`vehicle:${vehicleMasterId}`).emit("live_update", {
          vehicleId: vehicleMasterId,
          recorded_at: ts,
          ...live,
        });
      }

      inserted++;
    }

    await client.query("COMMIT");
    return { inserted };
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("Telemetry insert failed:", err);
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  insertTelemetryItems,
  setSocketIO,
};