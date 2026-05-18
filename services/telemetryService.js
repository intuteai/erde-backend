// services/telemetryService.js
const db     = require("../config/postgres");
const redis  = require("../config/redis");
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

   NEW columns added (19 total):
     $35–$38  : soh_percent, cycle_count, remaining_ah, charging_ah
     $39–$45  : string_voltage_1_v … string_voltage_7_v
     $46–$53  : string_temp_1_c … string_temp_8_c
   All subsequent $N shifted accordingly.
   cell_modules / temp_modules remain LAST (::jsonb cast).
========================= */
const LIVE_VALUES_COLUMNS = [
  "vehicle_master_id",              // $1
  "recorded_at",                    // $2
  // BATTERY — core
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
  // BATTERY — NEW health & capacity
  "soh_percent",                    // $15
  "cycle_count",                    // $16
  "remaining_ah",                   // $17
  "charging_ah",                    // $18
  // STRING VOLTAGES — NEW (7)
  "string_voltage_1_v",             // $19
  "string_voltage_2_v",             // $20
  "string_voltage_3_v",             // $21
  "string_voltage_4_v",             // $22
  "string_voltage_5_v",             // $23
  "string_voltage_6_v",             // $24
  "string_voltage_7_v",             // $25
  // STRING TEMPERATURES — NEW (8)
  "string_temp_1_c",                // $26
  "string_temp_2_c",                // $27
  "string_temp_3_c",                // $28
  "string_temp_4_c",                // $29
  "string_temp_5_c",                // $30
  "string_temp_6_c",                // $31
  "string_temp_7_c",                // $32
  "string_temp_8_c",                // $33
  // MOTOR / MCU
  "motor_torque_limit",             // $34
  "motor_torque_value",             // $35
  "motor_speed_rpm",                // $36
  "motor_rotation_dir",             // $37
  "motor_operation_mode",           // $38
  "mcu_enable_state",               // $39
  "motor_ac_current_a",             // $40
  "motor_ac_voltage_v",             // $41
  "dc_side_voltage_v",              // $42
  "motor_temp_c",                   // $43
  "mcu_temp_c",                     // $44
  "radiator_temp_c",                // $45
  // ODO / ENERGY
  "total_running_hrs",              // $46
  "last_trip_hrs",                  // $47
  "total_kwh_consumed",             // $48
  "last_trip_kwh",                  // $49
  // ALARMS
  "alarms",                         // $50
  // DCDC
  "dcdc_pri_a_mosfet_temp_c",       // $51
  "dcdc_sec_ls_mosfet_temp_c",      // $52
  "dcdc_sec_hs_mosfet_temp_c",      // $53
  "dcdc_pri_c_mosfet_temp_c",       // $54
  "dcdc_input_voltage_v",           // $55
  "dcdc_input_current_a",           // $56
  "dcdc_output_voltage_v",          // $57
  "dcdc_output_current_a",          // $58
  "dcdc_max_temp_c",                // $59
  "dcdc_occurence_count",           // $60
  // BTMS / BMS THERMAL
  "btms_command_mode",              // $61
  "btms_hv_request",                // $62
  "btms_charge_status",             // $63
  "bms_hv_relay_state",             // $64  — bms_ prefix (distinct DB column)
  "btms_target_temp_c",             // $65
  "bms_pack_voltage_v",             // $66
  "bms_life_counter",               // $67
  "btms_command_crc",               // $68
  "btms_status_mode",               // $69
  "btms_hv_relay_state",            // $70  — btms_ prefix (distinct DB column)
  "btms_inlet_temp_c",              // $71
  "btms_outlet_temp_c",             // $72
  "btms_demand_power_kw",           // $73
  // MOTOR EXTRAS
  "motor_status_word",              // $74  (varchar — app sends hex string)
  "motor_freq_raw",                 // $75
  "motor_total_wattage_w",          // $76
  // AIR COMPRESSOR
  "compressor_input_voltage_v",     // $77
  "compressor_input_current_a",     // $78
  "compressor_output_voltage_v",    // $79
  "compressor_output_current_a",    // $80
  // EVCC1 — EV Charging Controller
  "evcc1_pwr_stat",                 // $81
  "evcc1_socket_stat",              // $82
  "evcc1_evse_stat",                // $83
  "evcc1_evse_chg_finished",        // $84
  "evcc1_evse_processing",          // $85
  "evcc1_evse_isol_stat",           // $86
  "evcc1_evse_transfer_type",       // $87
  "evcc1_evse_notification",        // $88
  "evcc1_evse_pwr_delivery",        // $89
  "evcc1_chg_finished",             // $90
  "evcc1_cp_stat",                  // $91
  "evcc1_s2_on_stat",               // $92
  "evcc1_pd_stat",                  // $93
  "evcc1_duty_value",               // $94
  "evcc1_lock_stat",                // $95
  "evcc1_aag_value",                // $96
  "evcc1_error_code",               // $97
  "evcc1_step_num",                 // $98
  "evcc1_evse_max_delay_s",         // $99
  "evcc1_evse_max_volt_v",          // $100
  "evcc1_evse_max_curr_a",          // $101
  "evcc1_evse_out_volt_v",          // $102
  "evcc1_evse_out_curr_a",          // $103
  "evcc1_evse_min_volt_v",          // $104
  "evcc1_evse_min_curr_a",          // $105
  "evcc1_evse_max_pwr_w",           // $106
  "evcc1_lock_status",              // $107
  "evcc1_lock_alarm",               // $108
  "evcc1_dcac_chg_mode",            // $109
  "evcc1_evse_evcc_chg_finished",   // $110
  "evcc1_ac_max_current_value_a",   // $111
  // PERIPHERALS
  "hydraulic_oil_temp_c",           // $112
  // MUST BE LAST — jsonb columns
  "cell_modules",                   // $113
  "temp_modules",                   // $114
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
    // Accumulate max structure dims per vehicle across this batch.
    // Persisted to vehicle_master + Redis after COMMIT (fire-and-forget).
    const pendingStructure = new Map();

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
        // BATTERY — core
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
        // BATTERY — NEW health & capacity
        toNum(live.soh_percent),                      // $15
        live.cycle_count ?? null,                     // $16
        toNum(live.remaining_ah),                     // $17
        toNum(live.charging_ah),                      // $18
        // STRING VOLTAGES — NEW (7)
        toNum(live.string_voltage_1_v),               // $19
        toNum(live.string_voltage_2_v),               // $20
        toNum(live.string_voltage_3_v),               // $21
        toNum(live.string_voltage_4_v),               // $22
        toNum(live.string_voltage_5_v),               // $23
        toNum(live.string_voltage_6_v),               // $24
        toNum(live.string_voltage_7_v),               // $25
        // STRING TEMPERATURES — NEW (8)
        toNum(live.string_temp_1_c),                  // $26
        toNum(live.string_temp_2_c),                  // $27
        toNum(live.string_temp_3_c),                  // $28
        toNum(live.string_temp_4_c),                  // $29
        toNum(live.string_temp_5_c),                  // $30
        toNum(live.string_temp_6_c),                  // $31
        toNum(live.string_temp_7_c),                  // $32
        toNum(live.string_temp_8_c),                  // $33
        // MOTOR / MCU
        toNum(live.motor_torque_limit),               // $34
        toNum(live.motor_torque_value),               // $35
        live.motor_speed_rpm ?? null,                 // $36
        toText(live.motor_rotation_dir),              // $37
        toText(live.motor_operation_mode),            // $38
        toText(live.mcu_enable_state),                // $39
        toNum(live.motor_ac_current_a),               // $40
        toNum(live.motor_ac_voltage_v),               // $41
        toNum(live.dc_side_voltage_v),                // $42
        toNum(live.motor_temp_c),                     // $43
        toNum(live.mcu_temp_c),                       // $44
        toNum(live.radiator_temp_c),                  // $45
        // ODO / ENERGY
        toInterval(live.total_running_hrs),           // $46
        toInterval(live.last_trip_hrs),               // $47
        toNum(live.total_kwh_consumed),               // $48
        toNum(live.last_trip_kwh),                    // $49
        // ALARMS
        live.alarms ? JSON.stringify(live.alarms) : JSON.stringify({}), // $50
        // DCDC
        toNum(live.dcdc_pri_a_mosfet_temp_c),         // $51
        toNum(live.dcdc_sec_ls_mosfet_temp_c),        // $52
        toNum(live.dcdc_sec_hs_mosfet_temp_c),        // $53
        toNum(live.dcdc_pri_c_mosfet_temp_c),         // $54
        toNum(live.dcdc_input_voltage_v),             // $55
        toNum(live.dcdc_input_current_a),             // $56
        toNum(live.dcdc_output_voltage_v),            // $57
        toNum(live.dcdc_output_current_a),            // $58
        toNum(live.dcdc_max_temp_c),                  // $59
        live.dcdc_occurence_count ?? null,            // $60
        // BTMS / BMS THERMAL
        toNum(live.btms_command_mode),                // $61
        toNum(live.btms_hv_request),                  // $62
        toNum(live.btms_charge_status),               // $63
        toNum(live.bms_hv_relay_state),               // $64  — bms_ column
        toNum(live.btms_target_temp_c),               // $65
        toNum(live.bms_pack_voltage_v),               // $66
        toNum(live.bms_life_counter),                 // $67
        toNum(live.btms_command_crc),                 // $68
        toNum(live.btms_status_mode),                 // $69
        toNum(live.btms_hv_relay_state),              // $70  — btms_ column
        toNum(live.btms_inlet_temp_c),                // $71
        toNum(live.btms_outlet_temp_c),               // $72
        toNum(live.btms_demand_power_kw),             // $73
        // MOTOR EXTRAS
        toText(live.motor_status_word),               // $74
        toNum(live.motor_freq_raw),                   // $75
        toNum(live.motor_total_wattage_w),            // $76
        // AIR COMPRESSOR
        toNum(live.compressor_input_voltage_v),       // $77
        toNum(live.compressor_input_current_a),       // $78
        toNum(live.compressor_output_voltage_v),      // $79
        toNum(live.compressor_output_current_a),      // $80
        // EVCC1 — EV Charging Controller
        toNum(live.evcc1_pwr_stat),                   // $81
        toNum(live.evcc1_socket_stat),                // $82
        toNum(live.evcc1_evse_stat),                  // $83
        toNum(live.evcc1_evse_chg_finished),          // $84
        toNum(live.evcc1_evse_processing),            // $85
        toNum(live.evcc1_evse_isol_stat),             // $86
        toNum(live.evcc1_evse_transfer_type),         // $87
        toNum(live.evcc1_evse_notification),          // $88
        toNum(live.evcc1_evse_pwr_delivery),          // $89
        toNum(live.evcc1_chg_finished),               // $90
        toNum(live.evcc1_cp_stat),                    // $91
        toNum(live.evcc1_s2_on_stat),                 // $92
        toNum(live.evcc1_pd_stat),                    // $93
        toNum(live.evcc1_duty_value),                 // $94
        toNum(live.evcc1_lock_stat),                  // $95
        toNum(live.evcc1_aag_value),                  // $96
        toNum(live.evcc1_error_code),                 // $97
        toNum(live.evcc1_step_num),                   // $98
        toNum(live.evcc1_evse_max_delay_s),           // $99
        toNum(live.evcc1_evse_max_volt_v),            // $100
        toNum(live.evcc1_evse_max_curr_a),            // $101
        toNum(live.evcc1_evse_out_volt_v),            // $102
        toNum(live.evcc1_evse_out_curr_a),            // $103
        toNum(live.evcc1_evse_min_volt_v),            // $104
        toNum(live.evcc1_evse_min_curr_a),            // $105
        toNum(live.evcc1_evse_max_pwr_w),             // $106
        toNum(live.evcc1_lock_status),                // $107
        toNum(live.evcc1_lock_alarm),                 // $108
        toNum(live.evcc1_dcac_chg_mode),              // $109
        toNum(live.evcc1_evse_evcc_chg_finished),     // $110
        toNum(live.evcc1_ac_max_current_value_a),     // $111
        // PERIPHERALS
        toNum(live.hydraulic_oil_temp_c),             // $112
        // MUST BE LAST — jsonb columns
        toJsonb(live.cell_modules),                   // $113
        toJsonb(live.temp_modules),                   // $114
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
            soh_percent, cycle_count, remaining_ah, charging_ah,
            string_voltage_1_v, string_voltage_2_v, string_voltage_3_v,
            string_voltage_4_v, string_voltage_5_v, string_voltage_6_v,
            string_voltage_7_v,
            string_temp_1_c, string_temp_2_c, string_temp_3_c,
            string_temp_4_c, string_temp_5_c, string_temp_6_c,
            string_temp_7_c, string_temp_8_c,
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
            $15,$16,$17,$18,
            $19,$20,$21,$22,$23,$24,$25,
            $26,$27,$28,$29,$30,$31,$32,$33,
            $34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,
            $46,$47,$48,$49,
            $50,
            $51,$52,$53,$54,$55,$56,$57,$58,$59,$60,
            $61,$62,$63,$64,$65,$66,$67,$68,$69,$70,$71,$72,$73,
            $74,$75,$76,
            $77,$78,$79,$80,
            $81,$82,$83,$84,$85,$86,$87,$88,$89,$90,$91,$92,$93,
            $94,$95,$96,$97,$98,$99,$100,$101,$102,$103,$104,$105,$106,
            $107,$108,$109,$110,$111,
            $112,
            $113::jsonb,$114::jsonb
          )
          `,
          values
        );

        // Queue the socket emit — fires after COMMIT, never before
        if (io) {
          pendingEmits.push({ vehicleMasterId, ts, live });
        }

        inserted++;

        // Track max module/cell dimensions seen in this batch
        const rawCell = live.cell_modules;
        const rawTemp = live.temp_modules;
        if (Array.isArray(rawCell) || Array.isArray(rawTemp)) {
          let cellMods = 0, cellsPerMod = 0, tempMods = 0, sensorsPerMod = 0;
          if (Array.isArray(rawCell)) {
            cellMods = rawCell.length;
            for (const m of rawCell) {
              if (Array.isArray(m)) cellsPerMod = Math.max(cellsPerMod, m.length);
            }
          }
          if (Array.isArray(rawTemp)) {
            tempMods = rawTemp.length;
            for (const m of rawTemp) {
              if (Array.isArray(m)) sensorsPerMod = Math.max(sensorsPerMod, m.length);
            }
          }
          const prev = pendingStructure.get(vehicleMasterId) ?? { cellMods: 0, cellsPerMod: 0, tempMods: 0, sensorsPerMod: 0 };
          pendingStructure.set(vehicleMasterId, {
            cellMods:      Math.max(prev.cellMods,      cellMods),
            cellsPerMod:   Math.max(prev.cellsPerMod,   cellsPerMod),
            tempMods:      Math.max(prev.tempMods,      tempMods),
            sensorsPerMod: Math.max(prev.sensorsPerMod, sensorsPerMod),
          });
        }
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

    // Persist structure dims — fire-and-forget so we never block the response.
    // GREATEST ensures vehicle_master only updates when a new maximum is seen.
    for (const [vehicleId, { cellMods, cellsPerMod, tempMods, sensorsPerMod }] of pendingStructure) {
      db.query(
        `UPDATE vehicle_master
         SET max_cell_modules       = GREATEST(max_cell_modules,       $2),
             max_cells_per_module   = GREATEST(max_cells_per_module,   $3),
             max_temp_modules       = GREATEST(max_temp_modules,       $4),
             max_sensors_per_module = GREATEST(max_sensors_per_module, $5)
         WHERE vehicle_master_id = $1
           AND ($2 > max_cell_modules OR $3 > max_cells_per_module
                OR $4 > max_temp_modules OR $5 > max_sensors_per_module)`,
        [vehicleId, cellMods, cellsPerMod, tempMods, sensorsPerMod]
      ).catch(err => logger.warn(`Structure persist failed (vehicle ${vehicleId}): ${err.message}`));

      redis.set(
        `vehicle_structure:${vehicleId}`,
        JSON.stringify({ cellMods, cellsPerMod, tempMods, sensorsPerMod }),
        { EX: 86400 }
      ).catch(err => logger.warn(`Structure cache write failed (vehicle ${vehicleId}): ${err.message}`));
    }

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