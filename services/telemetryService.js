// services/telemetryService.js
const db = require("../config/postgres");
const logger = require("../utils/logger");
const crypto = require("crypto");

/* =========================
   SOCKET.IO INJECTION
========================= */
let io = null;

/**
 * Called once from server.js to inject the Socket.IO instance.
 */
const setSocketIO = (socketIO) => {
  io = socketIO;
};

/* =========================
   CONSTANTS
========================= */
const MAX_BATCH_SIZE   = 500;
const MAX_TS_AGE_MS    = 7 * 24 * 60 * 60 * 1000; // 7 days in the past
const MAX_TS_FUTURE_MS = 60_000;                    // 1 minute into the future

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

/**
 * Validates a millisecond epoch timestamp.
 * Rejects: null, non-numbers, NaN, negative, older than 7 days,
 * or more than 1 minute in the future.
 */
const toTimestamp = (ts) => {
  if (ts === null || ts === undefined) return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const now = Date.now();
  if (n < now - MAX_TS_AGE_MS)    return null;
  if (n > now + MAX_TS_FUTURE_MS) return null;
  return n;
};

/* =========================
   COLUMN REGISTRY
   Keep this in exact 1-to-1 sync with:
     (a) the values[] array below
     (b) the INSERT column list in the SQL
   The safety-check assert will catch any drift immediately.
========================= */
const LIVE_VALUES_COLUMNS = [
  "vehicle_master_id",              // $1
  "recorded_at",                    // $2
  // BATTERY
  "soc_percent",                    // $3
  "stack_voltage_v",                // $4
  "battery_status",                 // $5
  "max_voltage_v",                  // $6
  "min_voltage_v",                  // $7
  "avg_voltage_v",                  // $8
  "max_temp_c",                     // $9
  "min_temp_c",                     // $10
  "avg_temp_c",                     // $11
  "battery_current_a",              // $12
  "charger_current_demand_a",       // $13
  "charger_voltage_demand_v",       // $14
  // MOTOR / MCU
  "motor_torque_limit",             // $15
  "motor_torque_value",             // $16
  "motor_speed_rpm",                // $17
  "motor_rotation_dir",             // $18
  "motor_operation_mode",           // $19
  "mcu_enable_state",               // $20
  "motor_ac_current_a",             // $21
  "motor_ac_voltage_v",             // $22
  "dc_side_voltage_v",              // $23
  "motor_temp_c",                   // $24
  "mcu_temp_c",                     // $25
  "radiator_temp_c",                // $26
  // ODO / ENERGY
  "total_running_hrs",              // $27
  "last_trip_hrs",                  // $28
  "total_kwh_consumed",             // $29
  "last_trip_kwh",                  // $30
  // ALARMS
  "alarms",                         // $31
  // DCDC
  "dcdc_pri_a_mosfet_temp_c",       // $32
  "dcdc_sec_ls_mosfet_temp_c",      // $33
  "dcdc_sec_hs_mosfet_temp_c",      // $34
  "dcdc_pri_c_mosfet_temp_c",       // $35
  "dcdc_input_voltage_v",           // $36
  "dcdc_input_current_a",           // $37
  "dcdc_output_voltage_v",          // $38
  "dcdc_output_current_a",          // $39
  "dcdc_max_temp_c",                // $40
  "dcdc_occurence_count",           // $41
  // BTMS / BMS THERMAL
  "btms_command_mode",              // $42
  "btms_hv_request",                // $43
  "btms_charge_status",             // $44
  "bms_hv_relay_state",             // $45  — bms_ prefix (distinct DB column)
  "btms_target_temp_c",             // $46
  "bms_pack_voltage_v",             // $47
  "bms_life_counter",               // $48
  "btms_command_crc",               // $49
  "btms_status_mode",               // $50
  "btms_hv_relay_state",            // $51  — btms_ prefix (distinct DB column)
  "btms_inlet_temp_c",              // $52
  "btms_outlet_temp_c",             // $53
  "btms_demand_power_kw",           // $54
  // MOTOR EXTRAS
  "motor_status_word",              // $55  (varchar — app sends hex string)
  "motor_freq_raw",                 // $56
  "motor_total_wattage_w",          // $57
  // AIR COMPRESSOR
  "compressor_input_voltage_v",     // $58
  "compressor_input_current_a",     // $59
  "compressor_output_voltage_v",    // $60
  "compressor_output_current_a",    // $61
  // EVCC1 — EV Charging Controller
  "evcc1_pwr_stat",                 // $62
  "evcc1_socket_stat",              // $63
  "evcc1_evse_stat",                // $64
  "evcc1_evse_chg_finished",        // $65
  "evcc1_evse_processing",          // $66
  "evcc1_evse_isol_stat",           // $67
  "evcc1_evse_transfer_type",       // $68
  "evcc1_evse_notification",        // $69
  "evcc1_evse_pwr_delivery",        // $70
  "evcc1_chg_finished",             // $71
  "evcc1_cp_stat",                  // $72
  "evcc1_s2_on_stat",               // $73
  "evcc1_pd_stat",                  // $74
  "evcc1_duty_value",               // $75
  "evcc1_lock_stat",                // $76
  "evcc1_aag_value",                // $77
  "evcc1_error_code",               // $78
  "evcc1_step_num",                 // $79
  "evcc1_evse_max_delay_s",         // $80
  "evcc1_evse_max_volt_v",          // $81
  "evcc1_evse_max_curr_a",          // $82
  "evcc1_evse_out_volt_v",          // $83
  "evcc1_evse_out_curr_a",          // $84
  "evcc1_evse_min_volt_v",          // $85
  "evcc1_evse_min_curr_a",          // $86
  "evcc1_evse_max_pwr_w",           // $87
  "evcc1_lock_status",              // $88
  "evcc1_lock_alarm",               // $89
  "evcc1_dcac_chg_mode",            // $90
  "evcc1_evse_evcc_chg_finished",   // $91
  "evcc1_ac_max_current_value_a",   // $92
  // PERIPHERALS
  "hydraulic_oil_temp_c",           // $93
  // MUST BE LAST — jsonb columns
  "cell_modules",                   // $94
  "temp_modules",                   // $95
];

/* =========================
   MAIN INSERT FUNCTION
========================= */
const insertTelemetryItems = async (items = []) => {
  if (!items.length) return { inserted: 0 };

  // Hard cap — prevents a runaway batch from holding the DB pool hostage
  if (items.length > MAX_BATCH_SIZE) {
    throw new Error(`Batch size ${items.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
  }

  const reqId = crypto.randomUUID();

  logger.info("Telemetry batch received", {
    reqId,
    count: items.length,
  });

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    let inserted = 0;
    // Collect socket emits — fired only AFTER COMMIT so clients never
    // receive a live_update event for data that was never persisted.
    const pendingEmits = [];

    for (const item of items) {
      const { ts: rawTs, live = {} } = item;

      // --- Validate timestamp ---
      const ts = toTimestamp(rawTs);
      if (!ts) {
        logger.warn("Telemetry item has invalid/out-of-range timestamp – skipping", {
          reqId,
          rawTs,
        });
        continue;
      }

      // --- Extract vehicle_master_id — accept many key names from different device firmwares ---
      let vehicleMasterId =
        item.vehicleIdOrMasterId ||
        item.vehicleMasterId     ||
        item.vehicle_master_id   ||
        item.vehicleId           ||
        item.vehicle_id          ||
        item.vid                 ||
        item.deviceId            ||
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
        vehicleMasterId,                              // $1
        ts,                                           // $2
        // BATTERY
        toNum(live.soc_percent),                      // $3
        toNum(live.stack_voltage_v),                  // $4
        toText(live.battery_status),                  // $5
        toNum(live.max_voltage_v),                    // $6
        toNum(live.min_voltage_v),                    // $7
        toNum(live.avg_voltage_v),                    // $8
        toNum(live.max_temp_c),                       // $9
        toNum(live.min_temp_c),                       // $10
        toNum(live.avg_temp_c),                       // $11
        toNum(live.battery_current_a),                // $12
        toNum(live.charger_current_demand_a),         // $13
        toNum(live.charger_voltage_demand_v),         // $14
        // MOTOR / MCU
        toNum(live.motor_torque_limit),               // $15
        toNum(live.motor_torque_value),               // $16
        live.motor_speed_rpm ?? null,                 // $17
        toText(live.motor_rotation_dir),              // $18
        toText(live.motor_operation_mode),            // $19
        toText(live.mcu_enable_state),                // $20
        toNum(live.motor_ac_current_a),               // $21
        toNum(live.motor_ac_voltage_v),               // $22
        toNum(live.dc_side_voltage_v),                // $23
        toNum(live.motor_temp_c),                     // $24
        toNum(live.mcu_temp_c),                       // $25
        toNum(live.radiator_temp_c),                  // $26
        // ODO / ENERGY
        toInterval(live.total_running_hrs),           // $27
        toInterval(live.last_trip_hrs),               // $28
        toNum(live.total_kwh_consumed),               // $29
        toNum(live.last_trip_kwh),                    // $30
        // ALARMS
        live.alarms ? JSON.stringify(live.alarms) : JSON.stringify({}), // $31
        // DCDC
        toNum(live.dcdc_pri_a_mosfet_temp_c),         // $32
        toNum(live.dcdc_sec_ls_mosfet_temp_c),        // $33
        toNum(live.dcdc_sec_hs_mosfet_temp_c),        // $34
        toNum(live.dcdc_pri_c_mosfet_temp_c),         // $35
        toNum(live.dcdc_input_voltage_v),             // $36
        toNum(live.dcdc_input_current_a),             // $37
        toNum(live.dcdc_output_voltage_v),            // $38
        toNum(live.dcdc_output_current_a),            // $39
        toNum(live.dcdc_max_temp_c),                  // $40
        live.dcdc_occurence_count ?? null,            // $41
        // BTMS / BMS THERMAL
        toNum(live.btms_command_mode),                // $42
        toNum(live.btms_hv_request),                  // $43
        toNum(live.btms_charge_status),               // $44
        toNum(live.bms_hv_relay_state),               // $45  — bms_ column
        toNum(live.btms_target_temp_c),               // $46
        toNum(live.bms_pack_voltage_v),               // $47
        toNum(live.bms_life_counter),                 // $48
        toNum(live.btms_command_crc),                 // $49
        toNum(live.btms_status_mode),                 // $50
        toNum(live.btms_hv_relay_state),              // $51  — btms_ column
        toNum(live.btms_inlet_temp_c),                // $52
        toNum(live.btms_outlet_temp_c),               // $53
        toNum(live.btms_demand_power_kw),             // $54
        // MOTOR EXTRAS
        toText(live.motor_status_word),               // $55
        toNum(live.motor_freq_raw),                   // $56
        toNum(live.motor_total_wattage_w),            // $57
        // AIR COMPRESSOR
        toNum(live.compressor_input_voltage_v),       // $58
        toNum(live.compressor_input_current_a),       // $59
        toNum(live.compressor_output_voltage_v),      // $60
        toNum(live.compressor_output_current_a),      // $61
        // EVCC1 — EV Charging Controller
        toNum(live.evcc1_pwr_stat),                   // $62
        toNum(live.evcc1_socket_stat),                // $63
        toNum(live.evcc1_evse_stat),                  // $64
        toNum(live.evcc1_evse_chg_finished),          // $65
        toNum(live.evcc1_evse_processing),            // $66
        toNum(live.evcc1_evse_isol_stat),             // $67
        toNum(live.evcc1_evse_transfer_type),         // $68
        toNum(live.evcc1_evse_notification),          // $69
        toNum(live.evcc1_evse_pwr_delivery),          // $70
        toNum(live.evcc1_chg_finished),               // $71
        toNum(live.evcc1_cp_stat),                    // $72
        toNum(live.evcc1_s2_on_stat),                 // $73
        toNum(live.evcc1_pd_stat),                    // $74
        toNum(live.evcc1_duty_value),                 // $75
        toNum(live.evcc1_lock_stat),                  // $76
        toNum(live.evcc1_aag_value),                  // $77
        toNum(live.evcc1_error_code),                 // $78
        toNum(live.evcc1_step_num),                   // $79
        toNum(live.evcc1_evse_max_delay_s),           // $80
        toNum(live.evcc1_evse_max_volt_v),            // $81
        toNum(live.evcc1_evse_max_curr_a),            // $82
        toNum(live.evcc1_evse_out_volt_v),            // $83
        toNum(live.evcc1_evse_out_curr_a),            // $84
        toNum(live.evcc1_evse_min_volt_v),            // $85
        toNum(live.evcc1_evse_min_curr_a),            // $86
        toNum(live.evcc1_evse_max_pwr_w),             // $87
        toNum(live.evcc1_lock_status),                // $88
        toNum(live.evcc1_lock_alarm),                 // $89
        toNum(live.evcc1_dcac_chg_mode),              // $90
        toNum(live.evcc1_evse_evcc_chg_finished),     // $91
        toNum(live.evcc1_ac_max_current_value_a),     // $92
        // PERIPHERALS
        toNum(live.hydraulic_oil_temp_c),             // $93
        // MUST BE LAST — jsonb columns
        toJsonb(live.cell_modules),                   // $94
        toJsonb(live.temp_modules),                   // $95
      ];

      // Safety assert — if LIVE_VALUES_COLUMNS, values[], and SQL ever drift
      // out of sync, this throws immediately with a clear message during testing.
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
            dcdc_pri_a_mosfet_temp_c, dcdc_sec_ls_mosfet_temp_c,
            dcdc_sec_hs_mosfet_temp_c, dcdc_pri_c_mosfet_temp_c,
            dcdc_input_voltage_v, dcdc_input_current_a,
            dcdc_output_voltage_v, dcdc_output_current_a,
            dcdc_max_temp_c, dcdc_occurence_count,
            btms_command_mode, btms_hv_request, btms_charge_status,
            bms_hv_relay_state, btms_target_temp_c, bms_pack_voltage_v,
            bms_life_counter, btms_command_crc,
            btms_status_mode, btms_hv_relay_state,
            btms_inlet_temp_c, btms_outlet_temp_c, btms_demand_power_kw,
            motor_status_word, motor_freq_raw, motor_total_wattage_w,
            compressor_input_voltage_v, compressor_input_current_a,
            compressor_output_voltage_v, compressor_output_current_a,
            evcc1_pwr_stat, evcc1_socket_stat, evcc1_evse_stat,
            evcc1_evse_chg_finished, evcc1_evse_processing, evcc1_evse_isol_stat,
            evcc1_evse_transfer_type, evcc1_evse_notification, evcc1_evse_pwr_delivery,
            evcc1_chg_finished, evcc1_cp_stat, evcc1_s2_on_stat, evcc1_pd_stat,
            evcc1_duty_value, evcc1_lock_stat, evcc1_aag_value,
            evcc1_error_code, evcc1_step_num,
            evcc1_evse_max_delay_s, evcc1_evse_max_volt_v, evcc1_evse_max_curr_a,
            evcc1_evse_out_volt_v, evcc1_evse_out_curr_a,
            evcc1_evse_min_volt_v, evcc1_evse_min_curr_a, evcc1_evse_max_pwr_w,
            evcc1_lock_status, evcc1_lock_alarm, evcc1_dcac_chg_mode,
            evcc1_evse_evcc_chg_finished, evcc1_ac_max_current_value_a,
            hydraulic_oil_temp_c,
            cell_modules, temp_modules
          )
          VALUES (
            $1, to_timestamp($2 / 1000.0),
            $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
            $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
            $27,$28,$29,$30,
            $31,
            $32,$33,$34,$35,$36,$37,$38,$39,$40,$41,
            $42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,
            $55,$56,$57,
            $58,$59,$60,$61,
            $62,$63,$64,$65,$66,$67,$68,$69,$70,$71,$72,$73,$74,
            $75,$76,$77,$78,$79,$80,$81,$82,$83,$84,$85,$86,$87,
            $88,$89,$90,$91,$92,
            $93,
            $94::jsonb,$95::jsonb
          )
          `,
          values
        );

        // Queue the socket emit — fires after COMMIT, never before
        if (io) {
          pendingEmits.push({ vehicleMasterId, ts, live });
        }

        inserted++;
      } catch (itemErr) {
        // Decode which column caused the error from the $N in the error message
        const match = itemErr.where?.match(/\$(\d+)/);
        let overflow = null;

        if (match) {
          const idx = Number(match[1]) - 1;
          overflow = {
            column: LIVE_VALUES_COLUMNS[idx],
            value:  values[idx],
          };
        }

        logger.error("Telemetry item insert failed", {
          reqId,
          vehicleMasterId,
          code:     itemErr.code,
          message:  itemErr.message,
          detail:   itemErr.detail,
          overflow,
        });

        // Continue — one bad item must not abort the rest of the batch
        continue;
      }
    }

    await client.query("COMMIT");

    // Fire all socket events now that data is safely on disk
    for (const { vehicleMasterId, ts, live } of pendingEmits) {
      io.to(`vehicle:${vehicleMasterId}`).emit("live_update", {
        vehicleId:   vehicleMasterId,
        recorded_at: ts,
        ...live,
      });
    }

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
      code:    err.code,
      detail:  err.detail,
      hint:    err.hint,
      where:   err.where,
      stack:   err.stack?.split("\n").slice(0, 8).join("\n"),
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