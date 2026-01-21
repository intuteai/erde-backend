// services/telemetryService.js
const db = require("../config/postgres");
const logger = require("../utils/logger");
const crypto = require("crypto");

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

const toJsonb = (v) => {
  if (!v || typeof v !== "object") return null;
  return JSON.stringify(v);
};

const toInterval = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return `${v} seconds`;
  return String(v);
};

const LIVE_VALUES_COLUMNS = [
  "vehicle_master_id",
  "recorded_at",
  "soc_percent",
  "stack_voltage_v",
  "battery_status",
  "max_voltage_v",
  "min_voltage_v",
  "avg_voltage_v",
  "max_temp_c",
  "min_temp_c",
  "avg_temp_c",
  "battery_current_a",
  "charger_current_demand_a",
  "charger_voltage_demand_v",
  "motor_torque_limit",
  "motor_torque_value",
  "motor_speed_rpm",
  "motor_rotation_dir",
  "motor_operation_mode",
  "mcu_enable_state",
  "motor_ac_current_a",
  "motor_ac_voltage_v",
  "dc_side_voltage_v",
  "motor_temp_c",
  "mcu_temp_c",
  "radiator_temp_c",
  "total_running_hrs",
  "last_trip_hrs",
  "total_kwh_consumed",
  "last_trip_kwh",
  "alarms",
  "dcdc_pri_a_mosfet_temp_c",
  "dcdc_sec_ls_mosfet_temp_c",
  "dcdc_sec_hs_mosfet_temp_c",
  "dcdc_pri_c_mosfet_temp_c",
  "dcdc_input_voltage_v",
  "dcdc_input_current_a",
  "dcdc_output_voltage_v",
  "dcdc_output_current_a",
  "dcdc_occurence_count",
  "btms_command_mode",
  "btms_hv_request",
  "btms_charge_status",
  "bms_hv_relay_state",
  "btms_target_temp_c",
  "bms_pack_voltage_v",
  "bms_life_counter",
  "btms_command_crc",
  "btms_status_mode",
  "btms_hv_relay_state",
  "btms_inlet_temp_c",
  "btms_outlet_temp_c",
  "btms_demand_power_kw",
  "motor_status_word",
  "motor_freq_raw",
  "motor_total_wattage_w",
  "motor_dc_input_voltage_raw",
  "motor_ac_output_voltage_raw",
  // MUST BE LAST (matches DB column order)
  "cell_modules",
  "temp_modules",
];

/* =========================
   MAIN INSERT FUNCTION
========================= */
const insertTelemetryItems = async (items = []) => {
  if (!items.length) return { inserted: 0 };

  const reqId = crypto.randomUUID();

  logger.info("Telemetry batch received", {
    reqId,
    count: items.length,
  });

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    let inserted = 0;

    for (const item of items) {
      const { ts, live = {} } = item;

      // Extract vehicle_master_id flexibly
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
          reqId,
          itemKeys: Object.keys(item),
          sample: item,
        });
        continue;
      }

      vehicleMasterId = Number(vehicleMasterId);
      if (isNaN(vehicleMasterId) || vehicleMasterId <= 0) {
        logger.warn("Invalid vehicle_master_id (not a positive number)", { reqId });
        continue;
      }

      const values = [
        vehicleMasterId,
        ts,
        // BATTERY
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
        // MOTOR / MCU
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
        // ODO / ENERGY
        toInterval(live.total_running_hrs),
        toInterval(live.last_trip_hrs),
        toNum(live.total_kwh_consumed),
        toNum(live.last_trip_kwh),
        // ALARMS
        live.alarms ? JSON.stringify(live.alarms) : JSON.stringify({}),
        // DCDC
        toNum(live.dcdc_pri_a_mosfet_temp_c),
        toNum(live.dcdc_sec_ls_mosfet_temp_c),
        toNum(live.dcdc_sec_hs_mosfet_temp_c),
        toNum(live.dcdc_pri_c_mosfet_temp_c),
        toNum(live.dcdc_input_voltage_v),
        toNum(live.dcdc_input_current_a),
        toNum(live.dcdc_output_voltage_v),
        toNum(live.dcdc_output_current_a),
        live.dcdc_occurence_count ?? null,
        // BTMS / BMS THERMAL
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
        // MOTOR / INVERTER RAW
        toNum(live.motor_status_word),
        toNum(live.motor_freq_raw),
        toNum(live.motor_total_wattage_w),
        toNum(live.motor_dc_input_voltage_raw),
        toNum(live.motor_ac_output_voltage_raw),
        // MUST BE LAST — jsonb columns
        toJsonb(live.cell_modules),
        toJsonb(live.temp_modules),
      ];

      // Safety check
      if (values.length !== LIVE_VALUES_COLUMNS.length) {
        throw new Error(
          `SQL mismatch: columns=${LIVE_VALUES_COLUMNS.length}, values=${values.length}`
        );
      }

      try {
        await client.query(
          `
          INSERT INTO live_values (
            vehicle_master_id, recorded_at,
            soc_percent, stack_voltage_v, battery_status,
            max_voltage_v, min_voltage_v, avg_voltage_v,
            max_temp_c, min_temp_c, avg_temp_c,
            battery_current_a,
            charger_current_demand_a, charger_voltage_demand_v,
            motor_torque_limit, motor_torque_value, motor_speed_rpm,
            motor_rotation_dir, motor_operation_mode, mcu_enable_state,
            motor_ac_current_a, motor_ac_voltage_v, dc_side_voltage_v,
            motor_temp_c, mcu_temp_c, radiator_temp_c,
            total_running_hrs, last_trip_hrs,
            total_kwh_consumed, last_trip_kwh,
            alarms,
            dcdc_pri_a_mosfet_temp_c,
            dcdc_sec_ls_mosfet_temp_c,
            dcdc_sec_hs_mosfet_temp_c,
            dcdc_pri_c_mosfet_temp_c,
            dcdc_input_voltage_v,
            dcdc_input_current_a,
            dcdc_output_voltage_v,
            dcdc_output_current_a,
            dcdc_occurence_count,
            btms_command_mode, btms_hv_request, btms_charge_status,
            bms_hv_relay_state, btms_target_temp_c, bms_pack_voltage_v,
            bms_life_counter, btms_command_crc,
            btms_status_mode, btms_hv_relay_state,
            btms_inlet_temp_c, btms_outlet_temp_c, btms_demand_power_kw,
            motor_status_word, motor_freq_raw, motor_total_wattage_w,
            motor_dc_input_voltage_raw, motor_ac_output_voltage_raw,
            cell_modules, temp_modules
          )
          VALUES ($1, to_timestamp($2 / 1000.0), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57,$58,$59::jsonb,$60::jsonb)
          `,
          values
        );

        // Live socket push
        if (io) {
          io.to(`vehicle:${vehicleMasterId}`).emit("live_update", {
            vehicleId: vehicleMasterId,
            recorded_at: ts,
            ...live,
          });
        }

        inserted++;
      } catch (itemErr) {
        const match = itemErr.where?.match(/\$(\d+)/);
        let overflow = null;

        if (match) {
          const idx = Number(match[1]) - 1;
          overflow = {
            column: LIVE_VALUES_COLUMNS[idx],
            value: values[idx],
          };
        }

        logger.error("Telemetry item insert failed", {
          reqId,
          vehicleMasterId,
          code: itemErr.code,
          message: itemErr.message,
          detail: itemErr.detail,
          overflow,
        });

        continue;
      }
    }

    await client.query("COMMIT");

    logger.info("Telemetry batch committed", {
      reqId,
      inserted,
      totalReceived: items.length,
    });

    return { inserted };
  } catch (err) {
    await client.query("ROLLBACK");

    logger.error("Telemetry batch insert failed (transaction rolled back)", {
      reqId,
      message: err.message,
      code: err.code,
      detail: err.detail,
      hint: err.hint,
      where: err.where,
      stack: err.stack?.split("\n").slice(0, 8).join("\n"),
    });

    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  insertTelemetryItems,
  setSocketIO,
};