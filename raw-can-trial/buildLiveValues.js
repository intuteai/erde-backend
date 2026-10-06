'use strict';

/**
 * Raw CAN shadow trial: plain-JS port of the tablet app's
 * src/telemetry/buildLiveValues.ts.
 *
 * Behaviour MUST match the app exactly (same rounding, same freshness
 * defaults, same quirks, same key order) so that the backend-rebuilt
 * snapshot can be diffed field by field against what the app uploads.
 * Do not "fix" anything here without fixing the app first.
 *
 * Only deliberate difference: the app reads odometer values from
 * getOdoSnapshot() (an in-memory store on the tablet). The backend cannot
 * compute those, so they come from the optional `opts.odo` argument instead
 * (default {} -> all four odo fields null, same as the app with an empty
 * snapshot).
 *
 * Notes (app quirks reproduced intentionally):
 *  - FAULT_MAP is imported by the app but never used; not ported.
 *  - statusWordLabel / modeDisplayLabel helpers are unused in the app; not ported.
 */

// ---- BTMS enum -> smallint code (DB smallint columns) ----
const BTMS_MODE_TO_CODE = {
  shutdown: 0,
  cooling: 1,
  heating: 2,
  self_circulation: 3,
};

const HV_REQ_TO_CODE = {
  hv_on_request: 0,
  hv_off_request: 1,
};

const CHARGE_STATUS_TO_CODE = {
  not_charging: 0,
  charging: 1,
};

const RELAY_TO_CODE = {
  open: 0,
  closed: 1,
};

// helpers
const toNum = (x) =>
  x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x);

const round = (x, dp = 3) => {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return null;
  const f = Math.pow(10, dp);
  return Math.round(Number(x) * f) / f;
};

const minsToPgInterval = (mins) => {
  if (mins == null || !Number.isFinite(mins)) return null;
  const totalSec = Math.max(0, Math.round(mins * 60));
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

const makeNullGrid = (rows, cols) =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));

const KNOWN_M413_FLAGS = [
  'hardwareDriverFailure',
  'hardwareOvercurrentFault',
  'zeroOffsetFault',
  'fanFailure',
  'temperatureDifferenceFailure',
  'acHallFailure',
  'stallFailure',
  'lowVoltageUndervoltageFault',
  'softwareOvercurrentFault',
  'hardwareOvervoltageFault',
  'totalHardwareFailure',
  'busOvervoltageFault',
  'busbarUndervoltageFault',
  'moduleOverTemperatureFault',
  'moduleOverTemperatureWarning',
  'overspeedFault',
  'overRpmAlarmFlag',
  'motorOverTemperatureWarning',
  'motorOverTemperatureFault',
  'canOfflineFailure',
  'encoderFailure',
];

const toSnake = (s) =>
  s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()).replace(/^_/, '');

/**
 * @param {any} data  merged decoded-CAN state (same shape as the app's React state)
 * @param {{ fresh?: Record<string, boolean>, odo?: {
 *   totalRunMin?: number|null, keyCycleRunMin?: number|null,
 *   totalKWh?: number|null, keyCycleKWh?: number|null } }} [opts]
 */
function buildLiveValues(data, opts) {
  const fresh = opts?.fresh ?? {};
  const bms1Fresh = fresh.bms1 ?? true;
  const bms2Fresh = fresh.bms2 ?? true;
  const bms3Fresh = fresh.bms3 ?? true;
  const bms4Fresh = fresh.bms4 ?? true;
  const bms5Fresh = fresh.bms5 ?? true;
  const bms7Fresh = fresh.bms7 ?? true;
  const bms11Fresh = fresh.bms11 ?? true;
  const bms8Fresh = fresh.bms8 ?? true;
  // eslint-disable-next-line no-unused-vars
  const bms9Fresh = fresh.bms9 ?? true; // unused in app
  const bms10Fresh = fresh.bms10 ?? true;
  const bms12Fresh = fresh.bms12 ?? true;

  const imdFresh = fresh.imd ?? true;

  const dcdcStatus1Fresh = fresh.dcdcStatus1 ?? true;
  const dcdcStatus2Fresh = fresh.dcdcStatus2 ?? true;

  const btmsStatusFresh = fresh.btmsStatus ?? true;
  const btmsCmdFresh = fresh.btmsCmd ?? true;

  const air1Fresh = fresh.air1 ?? true;
  const air2Fresh = fresh.air2 ?? true;

  const motor411Fresh = fresh.motor411 ?? true;
  const motor412Fresh = fresh.motor412 ?? true;
  const motor413Fresh = fresh.motor413 ?? true;

  const evcc1ControlFresh = fresh.evcc1Control ?? true;
  const evcc1EvseLimitsFresh = fresh.evcc1EvseLimits ?? true;
  const evcc1EvseStatus2Fresh = fresh.evcc1EvseStatus2 ?? true;

  // ── Battery basics ──
  const soc_percent = round(toNum(data?.bms2?.SOC), 2);
  const soh_percent = round(toNum(data?.bms2?.SOH), 2);

  const stack_voltage_v = round(
    toNum(data?.bms12StringVoltages?.Pack_Voltage ?? data?.bms3?.PACKVOLTAGE),
    3
  );
  const cycle_count =
    toNum(data?.bms2?.CYCLE_COUNT) != null ? Math.trunc(toNum(data?.bms2?.CYCLE_COUNT)) : null;

  const remaining_ah = round(toNum(data?.bms3?.RAH), 2);
  const charging_ah = round(toNum(data?.bms3?.CAH), 2);

  const battery_current_a = round(
    toNum(data?.bms3?.PACKCURRENT ?? data?.bms10Currents?.Pack_Current),
    3
  );

  // App: BMS_STATE 2 -> "Charging", 3 -> "Discharging", anything else numeric -> "OFF".
  // (The app's comment says 3=Charging/2=Discharging; code is reproduced, not the comment.)
  const battery_status = (() => {
    const s = toNum(data?.bms1?.BMS_STATE);
    if (s === null) return null;
    if (s === 2) return 'Charging';
    if (s === 3) return 'Discharging';
    return 'OFF';
  })();

  const charger_current_demand_a = null;
  const charger_voltage_demand_v = null;

  // Cell voltage stats: bms4 is mV
  const max_voltage_v = round(
    toNum(data?.bms4?.MAX_CELL_VOLTAGE) != null ? Number(data.bms4.MAX_CELL_VOLTAGE) / 1000 : null,
    3
  );
  const min_voltage_v = round(
    toNum(data?.bms4?.MIN_CELL_VOLTAGE) != null ? Number(data.bms4.MIN_CELL_VOLTAGE) / 1000 : null,
    3
  );
  const avg_voltage_v = round(
    toNum(data?.bms4?.AVG_CELL_VOLTAGE) != null ? Number(data.bms4.AVG_CELL_VOLTAGE) / 1000 : null,
    3
  );

  const string_voltage_1_v = round(toNum(data?.bms11StringVoltages?.String_Voltage_1), 3);
  const string_voltage_2_v = round(toNum(data?.bms11StringVoltages?.String_Voltage_2), 3);
  const string_voltage_3_v = round(toNum(data?.bms11StringVoltages?.String_Voltage_3), 3);
  const string_voltage_4_v = round(toNum(data?.bms11StringVoltages?.String_Voltage_4), 3);

  const string_voltage_5_v = round(toNum(data?.bms12StringVoltages?.String_Voltage_5), 3);
  const string_voltage_6_v = round(toNum(data?.bms12StringVoltages?.String_Voltage_6), 3);
  const string_voltage_7_v = round(toNum(data?.bms12StringVoltages?.String_Voltage_7), 3);

  const max_temp_c = round(toNum(data?.bms5?.MAXTEMP), 2);
  const min_temp_c = round(toNum(data?.bms5?.MINTEMP), 2);
  const avg_temp_c = round(toNum(data?.bms5?.AVGTEMP), 2);

  const string_temp_1_c = round(toNum(data?.bms7?.Temp_1_String1_Positive_Busbar), 2);
  const string_temp_2_c = round(toNum(data?.bms7?.Temp_2_String1_Negative_Busbar), 2);
  const string_temp_3_c = round(toNum(data?.bms7?.Temp_3_String2_Positive_Busbar), 2);
  const string_temp_4_c = round(toNum(data?.bms7?.Temp_4_String2_Negative_Busbar), 2);
  const string_temp_5_c = round(toNum(data?.bms7?.Temp_5_String3_Positive_Busbar), 2);
  const string_temp_6_c = round(toNum(data?.bms7?.Temp_6_String3_Negative_Busbar), 2);
  const string_temp_7_c = round(toNum(data?.bms7?.Temp_7_Reserved), 2);
  const string_temp_8_c = round(toNum(data?.bms7?.Temp_8_Reserved), 2);

  // Staleness gating
  const soc_percent_final = bms2Fresh ? soc_percent : null;
  const cycle_count_final = bms2Fresh ? cycle_count : null;
  const remaining_ah_final = bms3Fresh ? remaining_ah : null;
  const charging_ah_final = bms3Fresh ? charging_ah : null;

  const stack_voltage_v_final = bms12Fresh || bms3Fresh ? stack_voltage_v : null;
  const battery_current_a_final = bms3Fresh || bms10Fresh ? battery_current_a : null;

  const battery_status_final = bms1Fresh ? battery_status : null;
  // Discharging => mcu_enabled, otherwise (including null) mcu_disabled
  const mcu_enable_state_final =
    battery_status_final === 'Discharging' ? 'mcu_enabled' : 'mcu_disabled';

  const max_voltage_v_final = bms4Fresh ? max_voltage_v : null;
  const min_voltage_v_final = bms4Fresh ? min_voltage_v : null;
  const avg_voltage_v_final = bms4Fresh ? avg_voltage_v : null;

  const max_temp_c_final = bms5Fresh ? max_temp_c : null;
  const min_temp_c_final = bms5Fresh ? min_temp_c : null;
  const avg_temp_c_final = bms5Fresh ? avg_temp_c : null;

  const soh_percent_final = bms2Fresh ? soh_percent : null;

  const string_voltage_1_v_final = bms11Fresh ? string_voltage_1_v : null;
  const string_voltage_2_v_final = bms11Fresh ? string_voltage_2_v : null;
  const string_voltage_3_v_final = bms11Fresh ? string_voltage_3_v : null;
  const string_voltage_4_v_final = bms11Fresh ? string_voltage_4_v : null;
  const string_voltage_5_v_final = bms12Fresh ? string_voltage_5_v : null;
  const string_voltage_6_v_final = bms12Fresh ? string_voltage_6_v : null;
  const string_voltage_7_v_final = bms12Fresh ? string_voltage_7_v : null;

  const string_temp_1_c_final = bms7Fresh ? string_temp_1_c : null;
  const string_temp_2_c_final = bms7Fresh ? string_temp_2_c : null;
  const string_temp_3_c_final = bms7Fresh ? string_temp_3_c : null;
  const string_temp_4_c_final = bms7Fresh ? string_temp_4_c : null;
  const string_temp_5_c_final = bms7Fresh ? string_temp_5_c : null;
  const string_temp_6_c_final = bms7Fresh ? string_temp_6_c : null;
  const string_temp_7_c_final = bms7Fresh ? string_temp_7_c : null;
  const string_temp_8_c_final = bms7Fresh ? string_temp_8_c : null;

  // Null grids (app has no per-cell / per-temp frames)
  const cell_modules = makeNullGrid(8, 24);
  const temp_modules = makeNullGrid(8, 18);

  // ── Motor / MCU ──
  const m411 = data?.message411 ?? {};
  const m412 = data?.message412 ?? {};
  const m413 = data?.message413 ?? {};

  const motor_torque_limit = round(toNum(m411.N_motorTorqueLim), 2);
  const motor_torque_value = round(toNum(m411.N_motorTorque), 2);

  const motor_speed_rpm =
    toNum(m411.N_motorSpeed) !== null ? Math.round(Number(m411.N_motorSpeed)) : null;

  const motor_rotation_dir = (() => {
    const dir = toNum(m411.St_motorDirection);
    if (dir === 1) return 'forward';
    if (dir === 2) return 'reverse';
    if (dir === 0) return 'stopped';
    return null;
  })();

  const motor_operation_mode = (() => {
    const mode = toNum(m411.St_motorMode);
    if (mode === null) return null;
    return `Mode_${mode}`;
  })();

  const motor_status_word = (() => {
    const st = toNum(m411.St_motor);
    if (st === null) return null;
    const rpm = toNum(m411.N_motorSpeed) ?? 0;
    if (rpm === 0) return 'Stopped';
    return 'Running';
  })();

  const motor_ac_current_a = round(toNum(m412.N_MotorACCurrent), 2);
  const motor_ac_voltage_v = round(toNum(m412.N_MotorACVoltage), 2);
  const dc_side_voltage_v = round(toNum(m412.N_MCUDCVoltage), 2);

  const motor_temp_c = round(toNum(m412.N_motorTemp), 1);
  const mcu_temp_c = round(toNum(m412.N_MCUTemp), 1);
  const radiator_temp_c = round(toNum(m413.radTemp), 1);

  // ── BTMS ──
  const btCmd = data?.btmsCommand ?? {};
  const btSt = data?.btmsStatus ?? {};

  const btms_command_mode =
    typeof btCmd.mode === 'string' ? (BTMS_MODE_TO_CODE[btCmd.mode] ?? null) : null;
  const btms_hv_request =
    typeof btCmd.hvRequest === 'string' ? (HV_REQ_TO_CODE[btCmd.hvRequest] ?? null) : null;
  const btms_charge_status =
    typeof btCmd.chargeStatus === 'string'
      ? (CHARGE_STATUS_TO_CODE[btCmd.chargeStatus] ?? null)
      : null;
  const bms_hv_relay_state =
    typeof btCmd.bmsHvRelayState === 'string'
      ? (RELAY_TO_CODE[btCmd.bmsHvRelayState] ?? null)
      : null;

  const btms_target_temp_c = round(toNum(btCmd.tempSetC), 2);
  const bms_pack_voltage_v = round(toNum(btCmd.packVoltageV), 3);

  const bms_life_counter =
    toNum(btCmd.lifeCounter) != null ? Math.trunc(toNum(btCmd.lifeCounter)) : null;
  const btms_command_crc = toNum(btCmd.crc) != null ? Math.trunc(toNum(btCmd.crc)) : null;

  const btms_status_mode =
    typeof btSt.tmsMode === 'string' ? (BTMS_MODE_TO_CODE[btSt.tmsMode] ?? null) : null;
  const btms_hv_relay_state =
    typeof btSt.hvRelayState === 'string' ? (RELAY_TO_CODE[btSt.hvRelayState] ?? null) : null;

  const btms_inlet_temp_c = round(toNum(btSt.inletWaterTempC), 2);
  const btms_outlet_temp_c = round(toNum(btSt.outletWaterTempC), 2);
  const btms_demand_power_kw = round(toNum(btSt.demandPowerKw), 3);

  const btms_command_mode_final = btmsCmdFresh ? btms_command_mode : null;
  const btms_hv_request_final = btmsCmdFresh ? btms_hv_request : null;
  const btms_charge_status_final = btmsCmdFresh ? btms_charge_status : null;
  const bms_hv_relay_state_final = btmsCmdFresh ? bms_hv_relay_state : null;
  const btms_target_temp_c_final = btmsCmdFresh ? btms_target_temp_c : null;
  const bms_pack_voltage_v_final = btmsCmdFresh ? bms_pack_voltage_v : null;
  const bms_life_counter_final = btmsCmdFresh ? bms_life_counter : null;
  const btms_command_crc_final = btmsCmdFresh ? btms_command_crc : null;

  const btms_status_mode_final = btmsStatusFresh ? btms_status_mode : null;
  const btms_hv_relay_state_final = btmsStatusFresh ? btms_hv_relay_state : null;
  const btms_inlet_temp_c_final = btmsStatusFresh ? btms_inlet_temp_c : null;
  const btms_outlet_temp_c_final = btmsStatusFresh ? btms_outlet_temp_c : null;
  const btms_demand_power_kw_final = btmsStatusFresh ? btms_demand_power_kw : null;

  const motor_torque_limit_final = motor411Fresh ? motor_torque_limit : null;
  const motor_torque_value_final = motor411Fresh ? motor_torque_value : null;
  const motor_speed_rpm_final = motor411Fresh ? motor_speed_rpm : null;

  const motor_rotation_dir_final = motor411Fresh ? motor_rotation_dir : null;
  const motor_operation_mode_final = motor411Fresh ? motor_operation_mode : null;
  const motor_status_word_final = motor411Fresh ? motor_status_word : null;

  const motor_ac_current_a_final = motor412Fresh ? motor_ac_current_a : null;
  const motor_ac_voltage_v_final = motor412Fresh ? motor_ac_voltage_v : null;
  const dc_side_voltage_v_final = motor412Fresh ? dc_side_voltage_v : null;
  const motor_temp_c_final = motor412Fresh ? motor_temp_c : null;
  const mcu_temp_c_final = motor412Fresh ? mcu_temp_c : null;

  const radiator_temp_c_final = motor413Fresh ? radiator_temp_c : null;

  const motor_freq_raw_final = null;
  const motor_total_wattage_w_final = null;

  // ── DCDC ──
  const dcdcStatus1 = data?.dcdcStatus1 ?? {};
  const dcdcStatus2 = data?.dcdcStatus2 ?? {};
  const dcdcVC = data?.dcdcVtgCur ?? {};

  const dcdc_pri_a_mosfet_temp_c_final = null;
  const dcdc_sec_ls_mosfet_temp_c_final = null;
  const dcdc_sec_hs_mosfet_temp_c_final = null;
  const dcdc_pri_c_mosfet_temp_c_final = null;

  const dcdc_input_voltage_v_final = dcdcStatus1Fresh
    ? round(toNum(dcdcVC.Input_Voltage ?? dcdcStatus1.inputVoltageV), 3)
    : null;
  const dcdc_input_current_a_final = dcdcStatus1Fresh
    ? round(toNum(dcdcVC.Input_Current ?? dcdcStatus1.inputCurrentA), 3)
    : null;
  const dcdc_output_voltage_v_final = dcdcStatus2Fresh
    ? round(toNum(dcdcVC.Output_Voltage ?? dcdcStatus2.outputVoltageV), 3)
    : null;
  const dcdc_output_current_a_final = dcdcStatus2Fresh
    ? round(toNum(dcdcVC.Output_Current ?? dcdcStatus2.outputCurrentA), 3)
    : null;
  const dcdc_max_temp_c_final = dcdcStatus2Fresh ? round(toNum(dcdcStatus2.maxTempC), 1) : null;

  const dcdc_occurence_count_final = null;

  // ── Compressor / air pump ──
  const ap1 = data?.airPumpStatus1 ?? {};
  const ap2 = data?.airPumpStatus2 ?? {};

  const compressor_input_voltage_v = air1Fresh ? round(toNum(ap1.inputVoltageV), 2) : null;
  const compressor_input_current_a = air1Fresh ? round(toNum(ap1.inputCurrentA), 2) : null;
  const compressor_output_voltage_v = air2Fresh ? round(toNum(ap2.outputVoltageV), 2) : null;
  const compressor_output_current_a = air2Fresh ? round(toNum(ap2.outputCurrentA), 2) : null;

  // ── EVCC-1 ──
  const evcc = data?.evcc ?? {};
  const evcc1Control = evcc?.control ?? {};
  const evcc1Limits = evcc?.evseLimits ?? {};
  const evcc1Status2 = evcc?.evseStatus2 ?? {};

  const evcc1_pwr_stat = evcc1ControlFresh ? toNum(evcc1Control.EVCC_PwrStat) : null;
  const evcc1_socket_stat = evcc1ControlFresh ? toNum(evcc1Control.EVCC_SocketStat) : null;
  const evcc1_evse_stat = evcc1ControlFresh ? toNum(evcc1Control.Evse_Stat) : null;
  const evcc1_evse_chg_finished = evcc1ControlFresh ? toNum(evcc1Control.Evse_ChgFinished) : null;
  const evcc1_evse_processing = evcc1ControlFresh ? toNum(evcc1Control.Evse_Processing) : null;
  const evcc1_evse_isol_stat = evcc1ControlFresh ? toNum(evcc1Control.Evse_IsolStat) : null;
  const evcc1_evse_transfer_type = evcc1ControlFresh ? toNum(evcc1Control.Evse_TransferType) : null;
  const evcc1_evse_notification = evcc1ControlFresh ? toNum(evcc1Control.Evse_Notification) : null;
  const evcc1_evse_pwr_delivery = evcc1ControlFresh ? toNum(evcc1Control.Evse_PwrDelivery) : null;
  const evcc1_chg_finished = evcc1ControlFresh ? toNum(evcc1Control.EVCC_ChgFinished) : null;
  const evcc1_cp_stat = evcc1ControlFresh ? toNum(evcc1Control.EVCC_CPStat) : null;
  const evcc1_s2_on_stat = evcc1ControlFresh ? toNum(evcc1Control.EVCC_S2_OnStat) : null;
  const evcc1_pd_stat = evcc1ControlFresh ? toNum(evcc1Control.EVCC_PDStat) : null;
  const evcc1_duty_value = evcc1ControlFresh ? toNum(evcc1Control.EVCC_DutyValue) : null;
  const evcc1_lock_stat = evcc1ControlFresh ? toNum(evcc1Control.EVCC_LockStat) : null;
  const evcc1_aag_value = evcc1ControlFresh ? toNum(evcc1Control.EVCC_AagValue) : null;
  const evcc1_error_code = evcc1ControlFresh ? toNum(evcc1Control.EVCC_ErrorCode) : null;
  const evcc1_step_num = evcc1ControlFresh ? toNum(evcc1Control.EVCC_StepNum) : null;
  const evcc1_evse_max_delay_s = evcc1ControlFresh ? toNum(evcc1Control.Evse_MaxDelay) : null;

  const evcc1_evse_max_volt_v = evcc1EvseLimitsFresh ? round(toNum(evcc1Limits.Evse_MaxVolt_V), 2) : null;
  const evcc1_evse_max_curr_a = evcc1EvseLimitsFresh ? round(toNum(evcc1Limits.Evse_MaxCurr_A), 2) : null;
  const evcc1_evse_out_volt_v = evcc1EvseLimitsFresh ? round(toNum(evcc1Limits.Evse_OutVolt_V), 2) : null;
  const evcc1_evse_out_curr_a = evcc1EvseLimitsFresh ? round(toNum(evcc1Limits.EVSE_OutCurr_A), 2) : null;

  const evcc1_evse_min_volt_v = evcc1EvseStatus2Fresh ? round(toNum(evcc1Status2.Evse_MinVolt_V), 2) : null;
  const evcc1_evse_min_curr_a = evcc1EvseStatus2Fresh ? round(toNum(evcc1Status2.Evse_MinCurr_A), 2) : null;
  const evcc1_evse_max_pwr_w = evcc1EvseStatus2Fresh ? round(toNum(evcc1Status2.Evse_MaxPwr_W), 2) : null;
  const evcc1_lock_status = evcc1EvseStatus2Fresh ? toNum(evcc1Status2.EVCC_Lock_status) : null;
  const evcc1_lock_alarm = evcc1EvseStatus2Fresh ? toNum(evcc1Status2.EVCC_Lock_alarm) : null;
  const evcc1_dcac_chg_mode = evcc1EvseStatus2Fresh ? toNum(evcc1Status2.Secc_DCAC_ChgMode) : null;
  const evcc1_evse_evcc_chg_finished = evcc1EvseStatus2Fresh ? toNum(evcc1Status2.EVSE_EVCC_ChgFinished) : null;
  const evcc1_ac_max_current_value_a = evcc1EvseStatus2Fresh ? toNum(evcc1Status2.Secc_ACMaxCurrentValue) : null;

  // ── Alarms ──
  const motorFaultFlags = {};
  for (const k of KNOWN_M413_FLAGS) {
    const v = toNum(m413?.[k]);
    motorFaultFlags[toSnake(k)] = motor413Fresh ? v === 1 : false;
  }
  const hasAnyMotorFault = motor413Fresh && Object.values(motorFaultFlags).some(Boolean);

  const bmsF = data?.bms8Faults ?? {};
  const imd = data?.imd ?? {};

  const dcdcProtocolFaults = dcdcStatus1?.faults ?? {};
  const dcdcFaults = {
    dcdc_fault_input_undervoltage: dcdcStatus1Fresh ? !!dcdcProtocolFaults.inputUndervoltage : false,
    dcdc_fault_input_overvoltage: dcdcStatus1Fresh ? !!dcdcProtocolFaults.inputOvervoltage : false,
    dcdc_fault_input_overcurrent: dcdcStatus1Fresh ? !!dcdcProtocolFaults.inputOvercurrent : false,
    dcdc_fault_output_undervoltage: dcdcStatus1Fresh ? !!dcdcProtocolFaults.outputUndervoltage : false,
    dcdc_fault_output_overvoltage: dcdcStatus1Fresh ? !!dcdcProtocolFaults.outputOvervoltage : false,
    dcdc_fault_output_overcurrent: dcdcStatus1Fresh ? !!dcdcProtocolFaults.outputOvercurrent : false,
    dcdc_fault_module_over_temp: dcdcStatus1Fresh ? !!dcdcProtocolFaults.moduleOverTemp : false,
    dcdc_fault_reduced_power: dcdcStatus1Fresh ? !!dcdcProtocolFaults.reducedPower : false,
  };

  const btmsFaultLevel = btSt?.faultLevel;
  const btmsFaults = {
    btms_fault_level1: btmsStatusFresh ? btmsFaultLevel === 'level1' : false,
    btms_fault_level2: btmsStatusFresh ? btmsFaultLevel === 'level2' : false,
    btms_fault_invalid: btmsStatusFresh ? btmsFaultLevel === 'invalid' : false,
  };

  const ap1Faults = ap1?.faults ?? {};
  const toBool = (x) => x === true;

  const compressor_has_fault_flag = air1Fresh ? toBool(ap1.hasFault) : false;
  const compressor_fault_overcurrent = air1Fresh ? toBool(ap1Faults.overcurrent) : false;
  const compressor_fault_overvoltage = air1Fresh ? toBool(ap1Faults.overvoltage) : false;
  const compressor_fault_overload = air1Fresh ? toBool(ap1Faults.overload) : false;
  const compressor_fault_undervoltage = air1Fresh ? toBool(ap1Faults.undervoltage) : false;
  const compressor_fault_breakage = air1Fresh ? toBool(ap1Faults.breakage) : false;
  const compressor_fault_short = air1Fresh ? toBool(ap1Faults.short) : false;
  const compressor_fault_shortage = air1Fresh ? toBool(ap1Faults.shortage) : false;
  const compressor_fault_overweight = air1Fresh ? toBool(ap1Faults.overweight) : false;

  const alarms = {
    faults: {
      has_any_motor_fault: hasAnyMotorFault,
      ...motorFaultFlags,
      compressor_has_fault: compressor_has_fault_flag,
      compressor_fault_overcurrent,
      compressor_fault_overvoltage,
      compressor_fault_overload,
      compressor_fault_undervoltage,
      compressor_fault_breakage,
      compressor_fault_short,
      compressor_fault_shortage,
      compressor_fault_overweight,
      ...dcdcFaults,
      ...btmsFaults,

      imd_insulation_alarm_1: imdFresh ? (toNum(imd.Insulation_Alarm_1) ?? 0) !== 0 : false,
      imd_insulation_alarm_2: imdFresh ? (toNum(imd.Insulation_Alarm_2) ?? 0) !== 0 : false,
      imd_battery_ov_alarm: imdFresh ? (toNum(imd.Battery_OV_Alarm) ?? 0) !== 0 : false,

      bms_cell_over_voltage: bms8Fresh ? (toNum(bmsF.CELLOVERVOLTAGEF1) ?? 0) !== 0 : false,
      bms_cell_under_voltage: bms8Fresh ? (toNum(bmsF.CELLUNDERVOLTAGEF1) ?? 0) !== 0 : false,
      bms_pack_over_voltage: bms8Fresh ? (toNum(bmsF.PACKOVERVOLTAGEF1) ?? 0) !== 0 : false,
      bms_pack_under_voltage: bms8Fresh ? (toNum(bmsF.PACKUNDERVOLTAGEF1) ?? 0) !== 0 : false,
      bms_charge_over_current: bms8Fresh ? (toNum(bmsF.CHARGEOVERCURRENTF1) ?? 0) !== 0 : false,
      bms_discharge_over_current: bms8Fresh ? (toNum(bmsF.DISCHARGEOVERCURRENTF1) ?? 0) !== 0 : false,
      bms_charge_over_temp: bms8Fresh ? (toNum(bmsF.CHARGEOVERTEMPERATUREF1) ?? 0) !== 0 : false,
      bms_charge_under_temp: bms8Fresh ? (toNum(bmsF.CHARGEUNDERTEMPERATUREF1) ?? 0) !== 0 : false,
      bms_discharge_over_temp: bms8Fresh ? (toNum(bmsF.DISCHARGEOVERTEMPERATUREF1) ?? 0) !== 0 : false,
      bms_discharge_under_temp: bms8Fresh ? (toNum(bmsF.DISCHARGEUNDERTEMPERATUREF1) ?? 0) !== 0 : false,
      bms_cell_voltage_diff: bms8Fresh ? (toNum(bmsF.CELLVOLTAGEDIFFERENCEF1) ?? 0) !== 0 : false,
      bms_imd_fault: bms8Fresh ? (toNum(bmsF.IMD_F1) ?? 0) !== 0 : false,
      bms_soc_low: bms8Fresh ? (toNum(bmsF.SOCLOWF1) ?? 0) !== 0 : false,
      bms_short_circuit: bms8Fresh ? (toNum(bmsF.SHORTCIRCUITF1) ?? 0) !== 0 : false,
      bms_thermal_runaway: bms8Fresh ? (toNum(bmsF.THERMALRUNAWAYF1) ?? 0) !== 0 : false,
      bms_hvil_fault: bms8Fresh ? (toNum(bmsF.HVILF1) ?? 0) !== 0 : false,
      bms_contactor_weld: bms8Fresh ? (toNum(bmsF.CONTACTORWELDF1) ?? 0) !== 0 : false,
    },
  };

  // ── Odometer (backend: supplied via opts.odo instead of getOdoSnapshot()) ──
  const odo = opts?.odo ?? {};

  const total_running_hrs = minsToPgInterval(odo.totalRunMin);
  const last_trip_hrs = minsToPgInterval(odo.keyCycleRunMin);
  const total_kwh_consumed = odo.totalKWh != null ? odo.totalKWh : null;
  const last_trip_kwh = odo.keyCycleKWh != null ? odo.keyCycleKWh : null;

  // ── Final payload (key order must match the app) ──
  return {
    soc_percent: soc_percent_final,
    soh_percent: soh_percent_final,
    cycle_count: cycle_count_final,
    remaining_ah: remaining_ah_final,
    charging_ah: charging_ah_final,

    stack_voltage_v: stack_voltage_v_final,
    battery_status: battery_status_final,
    battery_current_a: battery_current_a_final,

    charger_current_demand_a,
    charger_voltage_demand_v,

    max_voltage_v: max_voltage_v_final,
    min_voltage_v: min_voltage_v_final,
    avg_voltage_v: avg_voltage_v_final,

    string_voltage_1_v: string_voltage_1_v_final,
    string_voltage_2_v: string_voltage_2_v_final,
    string_voltage_3_v: string_voltage_3_v_final,
    string_voltage_4_v: string_voltage_4_v_final,
    string_voltage_5_v: string_voltage_5_v_final,
    string_voltage_6_v: string_voltage_6_v_final,
    string_voltage_7_v: string_voltage_7_v_final,

    max_temp_c: max_temp_c_final,
    min_temp_c: min_temp_c_final,
    avg_temp_c: avg_temp_c_final,

    string_temp_1_c: string_temp_1_c_final,
    string_temp_2_c: string_temp_2_c_final,
    string_temp_3_c: string_temp_3_c_final,
    string_temp_4_c: string_temp_4_c_final,
    string_temp_5_c: string_temp_5_c_final,
    string_temp_6_c: string_temp_6_c_final,
    string_temp_7_c: string_temp_7_c_final,
    string_temp_8_c: string_temp_8_c_final,

    motor_torque_limit: motor_torque_limit_final,
    motor_torque_value: motor_torque_value_final,
    motor_speed_rpm: motor_speed_rpm_final,

    motor_rotation_dir: motor_rotation_dir_final,
    motor_operation_mode: motor_operation_mode_final,
    mcu_enable_state: mcu_enable_state_final,
    motor_status_word: motor_status_word_final,

    motor_ac_current_a: motor_ac_current_a_final,
    motor_ac_voltage_v: motor_ac_voltage_v_final,
    dc_side_voltage_v: dc_side_voltage_v_final,

    motor_temp_c: motor_temp_c_final,
    mcu_temp_c: mcu_temp_c_final,
    radiator_temp_c: radiator_temp_c_final,

    btms_command_mode: btms_command_mode_final,
    btms_hv_request: btms_hv_request_final,
    btms_charge_status: btms_charge_status_final,
    bms_hv_relay_state: bms_hv_relay_state_final,
    btms_target_temp_c: btms_target_temp_c_final,
    bms_pack_voltage_v: bms_pack_voltage_v_final,
    bms_life_counter: bms_life_counter_final,
    btms_command_crc: btms_command_crc_final,

    btms_status_mode: btms_status_mode_final,
    btms_hv_relay_state: btms_hv_relay_state_final,
    btms_inlet_temp_c: btms_inlet_temp_c_final,
    btms_outlet_temp_c: btms_outlet_temp_c_final,
    btms_demand_power_kw: btms_demand_power_kw_final,

    motor_freq_raw: motor_freq_raw_final,
    motor_total_wattage_w: motor_total_wattage_w_final,

    alarms,

    total_running_hrs,
    last_trip_hrs,
    total_kwh_consumed,
    last_trip_kwh,

    dcdc_pri_a_mosfet_temp_c: dcdc_pri_a_mosfet_temp_c_final,
    dcdc_sec_ls_mosfet_temp_c: dcdc_sec_ls_mosfet_temp_c_final,
    dcdc_sec_hs_mosfet_temp_c: dcdc_sec_hs_mosfet_temp_c_final,
    dcdc_pri_c_mosfet_temp_c: dcdc_pri_c_mosfet_temp_c_final,

    dcdc_input_voltage_v: dcdc_input_voltage_v_final,
    dcdc_input_current_a: dcdc_input_current_a_final,
    dcdc_output_voltage_v: dcdc_output_voltage_v_final,
    dcdc_output_current_a: dcdc_output_current_a_final,
    dcdc_max_temp_c: dcdc_max_temp_c_final,

    dcdc_occurence_count: dcdc_occurence_count_final,

    cell_modules,
    temp_modules,

    compressor_input_voltage_v,
    compressor_input_current_a,
    compressor_output_voltage_v,
    compressor_output_current_a,

    evcc1_pwr_stat,
    evcc1_socket_stat,
    evcc1_evse_stat,
    evcc1_evse_chg_finished,
    evcc1_evse_processing,
    evcc1_evse_isol_stat,
    evcc1_evse_transfer_type,
    evcc1_evse_notification,
    evcc1_evse_pwr_delivery,
    evcc1_chg_finished,
    evcc1_cp_stat,
    evcc1_s2_on_stat,
    evcc1_pd_stat,
    evcc1_duty_value,
    evcc1_lock_stat,
    evcc1_aag_value,
    evcc1_error_code,
    evcc1_step_num,
    evcc1_evse_max_delay_s,

    evcc1_evse_max_volt_v,
    evcc1_evse_max_curr_a,
    evcc1_evse_out_volt_v,
    evcc1_evse_out_curr_a,

    evcc1_evse_min_volt_v,
    evcc1_evse_min_curr_a,
    evcc1_evse_max_pwr_w,
    evcc1_lock_status,
    evcc1_lock_alarm,
    evcc1_dcac_chg_mode,
    evcc1_evse_evcc_chg_finished,
    evcc1_ac_max_current_value_a,
  };
}

/** Output keys of buildLiveValues, in order. */
const LIVE_KEYS = Object.freeze(Object.keys(buildLiveValues({})));

module.exports = { buildLiveValues, LIVE_KEYS, minsToPgInterval };
