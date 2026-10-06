'use strict';

const { buildLiveValues, LIVE_KEYS } = require('../buildLiveValues');

const MOTOR_FLAG_KEYS = [
  'hardware_driver_failure',
  'hardware_overcurrent_fault',
  'zero_offset_fault',
  'fan_failure',
  'temperature_difference_failure',
  'ac_hall_failure',
  'stall_failure',
  'low_voltage_undervoltage_fault',
  'software_overcurrent_fault',
  'hardware_overvoltage_fault',
  'total_hardware_failure',
  'bus_overvoltage_fault',
  'busbar_undervoltage_fault',
  'module_over_temperature_fault',
  'module_over_temperature_warning',
  'overspeed_fault',
  'over_rpm_alarm_flag',
  'motor_over_temperature_warning',
  'motor_over_temperature_fault',
  'can_offline_failure',
  'encoder_failure',
];

const ALARM_KEYS = [
  'has_any_motor_fault',
  ...MOTOR_FLAG_KEYS,
  'compressor_has_fault',
  'compressor_fault_overcurrent',
  'compressor_fault_overvoltage',
  'compressor_fault_overload',
  'compressor_fault_undervoltage',
  'compressor_fault_breakage',
  'compressor_fault_short',
  'compressor_fault_shortage',
  'compressor_fault_overweight',
  'dcdc_fault_input_undervoltage',
  'dcdc_fault_input_overvoltage',
  'dcdc_fault_input_overcurrent',
  'dcdc_fault_output_undervoltage',
  'dcdc_fault_output_overvoltage',
  'dcdc_fault_output_overcurrent',
  'dcdc_fault_module_over_temp',
  'dcdc_fault_reduced_power',
  'btms_fault_level1',
  'btms_fault_level2',
  'btms_fault_invalid',
  'imd_insulation_alarm_1',
  'imd_insulation_alarm_2',
  'imd_battery_ov_alarm',
  'bms_cell_over_voltage',
  'bms_cell_under_voltage',
  'bms_pack_over_voltage',
  'bms_pack_under_voltage',
  'bms_charge_over_current',
  'bms_discharge_over_current',
  'bms_charge_over_temp',
  'bms_charge_under_temp',
  'bms_discharge_over_temp',
  'bms_discharge_under_temp',
  'bms_cell_voltage_diff',
  'bms_imd_fault',
  'bms_soc_low',
  'bms_short_circuit',
  'bms_thermal_runaway',
  'bms_hvil_fault',
  'bms_contactor_weld',
];

const allFalse = (keys) => Object.fromEntries(keys.map((k) => [k, false]));

/** Realistic merged state, values shaped like the app's parsers produce. */
function fullData() {
  return {
    bms1: { BMS_STATE: 3, CHARGE_FULL_FLAG: 0, HVIL_1_Status: 1 },
    bms2: { SOC: 78.456, SOH: 97.333, CYCLE_COUNT: 412, Software_Version: 1.02 },
    bms3: {
      RAH: 201.35000000000002,
      CAH: 12.05,
      PACKVOLTAGE: 612.45,
      PACKCURRENT: -45.300000000000004,
    },
    bms4: { MAX_CELL_VOLTAGE: 3412, MIN_CELL_VOLTAGE: 3398, AVG_CELL_VOLTAGE: 3405, CELL_VOLTAGE_DIFFERENCE: 14 },
    bms5: { MAXTEMP: 34.34375, MINTEMP: 28.09375, AVGTEMP: 31.5, TEMP_DIFFERENCE: -266.75 },
    bms7: {
      Temp_1_String1_Positive_Busbar: 30,
      Temp_2_String1_Negative_Busbar: 31,
      Temp_3_String2_Positive_Busbar: 29,
      Temp_4_String2_Negative_Busbar: 32,
      Temp_5_String3_Positive_Busbar: 33,
      Temp_6_String3_Negative_Busbar: -2,
      Temp_7_Reserved: 0,
      Temp_8_Reserved: -40,
    },
    bms8Faults: {
      CELLOVERVOLTAGEF1: 0,
      CELLUNDERVOLTAGEF1: 2,
      PACKOVERVOLTAGEF1: 0,
      PACKUNDERVOLTAGEF1: 0,
      CHARGEOVERCURRENTF1: 0,
      DISCHARGEOVERCURRENTF1: 0,
      CHARGEOVERTEMPERATUREF1: 0,
      CHARGEUNDERTEMPERATUREF1: 0,
      DISCHARGEOVERTEMPERATUREF1: 0,
      DISCHARGEUNDERTEMPERATUREF1: 0,
      CELLVOLTAGEDIFFERENCEF1: 1,
      IMD_F1: 0,
      SOCLOWF1: 0,
      SHORTCIRCUITF1: 0,
      THERMALRUNAWAYF1: 0,
      HVILF1: 3,
      CONTACTORWELDF1: 0,
    },
    bms9Energy: { Kwh_Used: 1234.56, Kwh_Pump: 2.5 },
    bms10Currents: { CS_1: 15, CS_2: 15.1, CS_3: 15.2, Pack_Current: 45.3 },
    bms11StringVoltages: {
      String_Voltage_1: 612.1,
      String_Voltage_2: 612.2000000000001,
      String_Voltage_3: 612.3000000000001,
      String_Voltage_4: 0,
    },
    bms12StringVoltages: {
      String_Voltage_5: 1.0005,
      String_Voltage_6: 600,
      String_Voltage_7: 0,
      Pack_Voltage: 612.3500000000001,
    },
    imd: { Insulation_Alarm_1: 0, Insulation_Alarm_2: 1, Battery_OV_Alarm: 0, BAT_Voltage: 612.3 },
    message411: {
      N_motorTorqueLim: 350,
      N_motorTorque: 120.456,
      N_motorSpeed: 1500.6,
      St_motorDirection: 1,
      St_motorMode: 2,
      St_motor: 1,
      St_MCU_enable: 1,
    },
    message412: {
      N_MotorACCurrent: 85.30000000000001,
      N_MotorACVoltage: 380.1,
      N_MCUDCVoltage: 611.9000000000001,
      N_motorTemp: 55,
      N_MCUTemp: 48,
    },
    message413: {
      hardwareDriverFailure: 0,
      hardwareOvercurrentFault: 0,
      zeroOffsetFault: 0,
      fanFailure: 1,
      temperatureDifferenceFailure: 0,
      acHallFailure: 0,
      stallFailure: 0,
      lowVoltageUndervoltageFault: 0,
      softwareOvercurrentFault: 0,
      hardwareOvervoltageFault: 0,
      totalHardwareFailure: 0,
      busOvervoltageFault: 0,
      busbarUndervoltageFault: 0,
      moduleOverTemperatureFault: 0,
      moduleOverTemperatureWarning: 0,
      overspeedFault: 0,
      overRpmAlarmFlag: 0,
      motorOverTemperatureWarning: 0,
      motorOverTemperatureFault: 0,
      canOfflineFailure: 0,
      encoderFailure: 1,
      radTemp: 41,
    },
    dcdcStatus1: {
      mode: 'running',
      faults: {
        inputUndervoltage: false,
        inputOvervoltage: true,
        inputOvercurrent: false,
        outputUndervoltage: false,
        outputOvervoltage: false,
        outputOvercurrent: false,
        moduleOverTemp: false,
        reducedPower: true,
      },
      inputVoltageV: 610.2,
      inputCurrentA: 3.4000000000000004,
    },
    dcdcStatus2: { outputVoltageV: 27.6, outputCurrentA: 45.5, maxTempC: 52 },
    dcdcVtgCur: { Input_Voltage: 610.2, Input_Current: 3.4000000000000004, Output_Voltage: 27.6, Output_Current: 45.5 },
    btmsStatus: {
      tmsMode: 'cooling',
      hvRelayState: 'closed',
      outletWaterTempC: 22,
      inletWaterTempC: 26,
      demandPowerKw: 1.5,
      faultLevel: 'level2',
    },
    btmsCommand: {
      mode: 'heating',
      hvRequest: 'hv_off_request',
      chargeStatus: 'charging',
      bmsHvRelayState: 'open',
      packVoltageV: 612,
      tempSetC: 25,
      lifeCounter: 17,
      crc: 203,
    },
    airPumpStatus1: {
      faults: {
        overcurrent: false,
        overvoltage: true,
        overload: false,
        undervoltage: false,
        breakage: false,
        short: false,
        shortage: false,
        overweight: false,
      },
      hasFault: true,
      inputVoltageV: 611.7,
      inputCurrentA: 2.3000000000000003,
    },
    airPumpStatus2: { motorSpeedRpm: 1200, outputVoltageV: 380.5, outputCurrentA: 4.1000000000000005 },
    evcc: {
      control: {
        EVCC_PwrStat: 1,
        EVCC_SocketStat: 1,
        Evse_Stat: 5,
        Evse_ChgFinished: 0,
        Evse_Processing: 1,
        Evse_IsolStat: 1,
        Evse_TransferType: 2,
        Evse_Notification: 0,
        Evse_PwrDelivery: 1,
        EVCC_ChgFinished: 0,
        EVCC_CPStat: 3,
        EVCC_S2_OnStat: 1,
        EVCC_PDStat: 2,
        EVCC_DutyValue: 53,
        EVCC_LockStat: 1,
        EVCC_AagValue: 100,
        EVCC_ErrorCode: 0,
        EVCC_StepNum: 7,
        Evse_MaxDelay: 10,
      },
      evseLimits: {
        Evse_MaxVolt_V: 750.0000000000001,
        Evse_MaxCurr_A: 200,
        Evse_OutVolt_V: 613.1,
        EVSE_OutCurr_A: 99.95,
      },
      evseStatus2: {
        Evse_MinVolt_V: 150,
        Evse_MinCurr_A: 0.5,
        Evse_MaxPwr_W: 120000,
        EVCC_Lock_status: 1,
        EVCC_Lock_alarm: 0,
        Secc_DCAC_ChgMode: 2,
        EVSE_EVCC_ChgFinished: 0,
        Secc_ACMaxCurrentValue: 32,
      },
    },
  };
}

describe('buildLiveValues (raw CAN shadow port)', () => {
  test('LIVE_KEYS lists every output key in app order', () => {
    const out = buildLiveValues({});
    expect(Object.keys(out)).toEqual([...LIVE_KEYS]);
    // Exact key order of the app's return object (src/telemetry/buildLiveValues.ts)
    expect([...LIVE_KEYS]).toEqual([
      'soc_percent', 'soh_percent', 'cycle_count', 'remaining_ah', 'charging_ah', 'stack_voltage_v',
      'battery_status', 'battery_current_a', 'charger_current_demand_a', 'charger_voltage_demand_v',
      'max_voltage_v', 'min_voltage_v', 'avg_voltage_v', 'string_voltage_1_v', 'string_voltage_2_v',
      'string_voltage_3_v', 'string_voltage_4_v', 'string_voltage_5_v', 'string_voltage_6_v',
      'string_voltage_7_v', 'max_temp_c', 'min_temp_c', 'avg_temp_c', 'string_temp_1_c',
      'string_temp_2_c', 'string_temp_3_c', 'string_temp_4_c', 'string_temp_5_c', 'string_temp_6_c',
      'string_temp_7_c', 'string_temp_8_c', 'motor_torque_limit', 'motor_torque_value',
      'motor_speed_rpm', 'motor_rotation_dir', 'motor_operation_mode', 'mcu_enable_state',
      'motor_status_word', 'motor_ac_current_a', 'motor_ac_voltage_v', 'dc_side_voltage_v',
      'motor_temp_c', 'mcu_temp_c', 'radiator_temp_c', 'btms_command_mode', 'btms_hv_request',
      'btms_charge_status', 'bms_hv_relay_state', 'btms_target_temp_c', 'bms_pack_voltage_v',
      'bms_life_counter', 'btms_command_crc', 'btms_status_mode', 'btms_hv_relay_state',
      'btms_inlet_temp_c', 'btms_outlet_temp_c', 'btms_demand_power_kw', 'motor_freq_raw',
      'motor_total_wattage_w', 'alarms', 'total_running_hrs', 'last_trip_hrs', 'total_kwh_consumed',
      'last_trip_kwh', 'dcdc_pri_a_mosfet_temp_c', 'dcdc_sec_ls_mosfet_temp_c',
      'dcdc_sec_hs_mosfet_temp_c', 'dcdc_pri_c_mosfet_temp_c', 'dcdc_input_voltage_v',
      'dcdc_input_current_a', 'dcdc_output_voltage_v', 'dcdc_output_current_a', 'dcdc_max_temp_c',
      'dcdc_occurence_count', 'cell_modules', 'temp_modules', 'compressor_input_voltage_v',
      'compressor_input_current_a', 'compressor_output_voltage_v', 'compressor_output_current_a',
      'evcc1_pwr_stat', 'evcc1_socket_stat', 'evcc1_evse_stat', 'evcc1_evse_chg_finished',
      'evcc1_evse_processing', 'evcc1_evse_isol_stat', 'evcc1_evse_transfer_type',
      'evcc1_evse_notification', 'evcc1_evse_pwr_delivery', 'evcc1_chg_finished', 'evcc1_cp_stat',
      'evcc1_s2_on_stat', 'evcc1_pd_stat', 'evcc1_duty_value', 'evcc1_lock_stat', 'evcc1_aag_value',
      'evcc1_error_code', 'evcc1_step_num', 'evcc1_evse_max_delay_s', 'evcc1_evse_max_volt_v',
      'evcc1_evse_max_curr_a', 'evcc1_evse_out_volt_v', 'evcc1_evse_out_curr_a',
      'evcc1_evse_min_volt_v', 'evcc1_evse_min_curr_a', 'evcc1_evse_max_pwr_w', 'evcc1_lock_status',
      'evcc1_lock_alarm', 'evcc1_dcac_chg_mode', 'evcc1_evse_evcc_chg_finished',
      'evcc1_ac_max_current_value_a',
    ]);
    expect(LIVE_KEYS).toHaveLength(111);
  });

  test('empty data gives an all-null snapshot with null grids, false alarms, mcu_disabled', () => {
    for (const input of [{}, null, undefined]) {
      const out = buildLiveValues(input);
      for (const k of LIVE_KEYS) {
        if (['alarms', 'cell_modules', 'temp_modules', 'mcu_enable_state'].includes(k)) continue;
        expect([k, out[k]]).toEqual([k, null]);
      }
      expect(out.soc_percent).toBeNull();
      expect(out.battery_status).toBeNull();
      expect(out.motor_speed_rpm).toBeNull();
      expect(out.btms_command_mode).toBeNull();
      expect(out.mcu_enable_state).toBe('mcu_disabled');
      expect(out.cell_modules).toHaveLength(8);
      out.cell_modules.forEach((row) => expect(row).toEqual(new Array(24).fill(null)));
      expect(out.temp_modules).toHaveLength(8);
      out.temp_modules.forEach((row) => expect(row).toEqual(new Array(18).fill(null)));
      expect(Object.keys(out.alarms)).toEqual(['faults']);
      expect(Object.keys(out.alarms.faults)).toEqual(ALARM_KEYS);
      expect(out.alarms.faults).toEqual(allFalse(ALARM_KEYS));
    }
  });

  test('grid rows are distinct arrays per call', () => {
    const a = buildLiveValues({});
    const b = buildLiveValues({});
    expect(a.cell_modules).not.toBe(b.cell_modules);
    expect(a.cell_modules[0]).not.toBe(a.cell_modules[1]);
  });

  describe('realistic full data', () => {
    const out = buildLiveValues(fullData());

    test('battery group', () => {
      expect(out).toMatchObject({
        soc_percent: 78.46,
        soh_percent: 97.33,
        cycle_count: 412,
        remaining_ah: 201.35,
        charging_ah: 12.05,
        // bms12 Pack_Voltage wins over bms3 PACKVOLTAGE
        stack_voltage_v: 612.35,
        battery_status: 'Discharging',
        // bms3 PACKCURRENT wins over bms10 Pack_Current
        battery_current_a: -45.3,
        charger_current_demand_a: null,
        charger_voltage_demand_v: null,
        max_voltage_v: 3.412,
        min_voltage_v: 3.398,
        avg_voltage_v: 3.405,
        max_temp_c: 34.34,
        min_temp_c: 28.09,
        avg_temp_c: 31.5,
      });
    });

    test('string voltages and temps', () => {
      expect(out).toMatchObject({
        string_voltage_1_v: 612.1,
        string_voltage_2_v: 612.2,
        string_voltage_3_v: 612.3,
        string_voltage_4_v: 0,
        string_voltage_5_v: 1.001, // Math.round(1.0005 * 1000) / 1000, same float behaviour as the app
        string_voltage_6_v: 600,
        string_voltage_7_v: 0,
        string_temp_1_c: 30,
        string_temp_2_c: 31,
        string_temp_3_c: 29,
        string_temp_4_c: 32,
        string_temp_5_c: 33,
        string_temp_6_c: -2,
        string_temp_7_c: 0,
        string_temp_8_c: -40,
      });
    });

    test('motor 411/412/413', () => {
      expect(out).toMatchObject({
        motor_torque_limit: 350,
        motor_torque_value: 120.46,
        motor_speed_rpm: 1501,
        motor_rotation_dir: 'forward',
        motor_operation_mode: 'Mode_2',
        mcu_enable_state: 'mcu_enabled',
        motor_status_word: 'Running',
        motor_ac_current_a: 85.3,
        motor_ac_voltage_v: 380.1,
        dc_side_voltage_v: 611.9,
        motor_temp_c: 55,
        mcu_temp_c: 48,
        radiator_temp_c: 41,
        motor_freq_raw: null,
        motor_total_wattage_w: null,
      });
    });

    test('BTMS codes', () => {
      expect(out).toMatchObject({
        btms_command_mode: 2,
        btms_hv_request: 1,
        btms_charge_status: 1,
        bms_hv_relay_state: 0,
        btms_target_temp_c: 25,
        bms_pack_voltage_v: 612,
        bms_life_counter: 17,
        btms_command_crc: 203,
        btms_status_mode: 1,
        btms_hv_relay_state: 1,
        btms_inlet_temp_c: 26,
        btms_outlet_temp_c: 22,
        btms_demand_power_kw: 1.5,
      });
    });

    test('DCDC and compressor', () => {
      expect(out).toMatchObject({
        dcdc_pri_a_mosfet_temp_c: null,
        dcdc_sec_ls_mosfet_temp_c: null,
        dcdc_sec_hs_mosfet_temp_c: null,
        dcdc_pri_c_mosfet_temp_c: null,
        dcdc_input_voltage_v: 610.2,
        dcdc_input_current_a: 3.4,
        dcdc_output_voltage_v: 27.6,
        dcdc_output_current_a: 45.5,
        dcdc_max_temp_c: 52,
        dcdc_occurence_count: null,
        compressor_input_voltage_v: 611.7,
        compressor_input_current_a: 2.3,
        compressor_output_voltage_v: 380.5,
        compressor_output_current_a: 4.1,
      });
    });

    test('EVCC', () => {
      expect(out).toMatchObject({
        evcc1_pwr_stat: 1,
        evcc1_socket_stat: 1,
        evcc1_evse_stat: 5,
        evcc1_evse_chg_finished: 0,
        evcc1_evse_processing: 1,
        evcc1_evse_isol_stat: 1,
        evcc1_evse_transfer_type: 2,
        evcc1_evse_notification: 0,
        evcc1_evse_pwr_delivery: 1,
        evcc1_chg_finished: 0,
        evcc1_cp_stat: 3,
        evcc1_s2_on_stat: 1,
        evcc1_pd_stat: 2,
        evcc1_duty_value: 53,
        evcc1_lock_stat: 1,
        evcc1_aag_value: 100,
        evcc1_error_code: 0,
        evcc1_step_num: 7,
        evcc1_evse_max_delay_s: 10,
        evcc1_evse_max_volt_v: 750,
        evcc1_evse_max_curr_a: 200,
        evcc1_evse_out_volt_v: 613.1,
        evcc1_evse_out_curr_a: 99.95,
        evcc1_evse_min_volt_v: 150,
        evcc1_evse_min_curr_a: 0.5,
        evcc1_evse_max_pwr_w: 120000,
        evcc1_lock_status: 1,
        evcc1_lock_alarm: 0,
        evcc1_dcac_chg_mode: 2,
        evcc1_evse_evcc_chg_finished: 0,
        evcc1_ac_max_current_value_a: 32,
      });
    });

    test('alarm flags', () => {
      const expected = allFalse(ALARM_KEYS);
      Object.assign(expected, {
        has_any_motor_fault: true,
        fan_failure: true,
        encoder_failure: true,
        compressor_has_fault: true,
        compressor_fault_overvoltage: true,
        dcdc_fault_input_overvoltage: true,
        dcdc_fault_reduced_power: true,
        btms_fault_level2: true,
        imd_insulation_alarm_2: true,
        bms_cell_under_voltage: true,
        bms_cell_voltage_diff: true,
        bms_hvil_fault: true,
      });
      expect(out.alarms.faults).toEqual(expected);
      expect(Object.keys(out.alarms.faults)).toEqual(ALARM_KEYS);
    });

    test('grids are still null and odo still null', () => {
      expect(out.cell_modules.flat().every((v) => v === null)).toBe(true);
      expect(out.temp_modules.flat().every((v) => v === null)).toBe(true);
      expect(out.total_running_hrs).toBeNull();
      expect(out.last_trip_hrs).toBeNull();
      expect(out.total_kwh_consumed).toBeNull();
      expect(out.last_trip_kwh).toBeNull();
    });
  });

  describe('staleness', () => {
    test('fresh.bms2 = false nulls SOC/SOH/cycle count only', () => {
      const out = buildLiveValues(fullData(), { fresh: { bms2: false } });
      expect(out.soc_percent).toBeNull();
      expect(out.soh_percent).toBeNull();
      expect(out.cycle_count).toBeNull();
      expect(out.remaining_ah).toBe(201.35);
      expect(out.battery_status).toBe('Discharging');
    });

    test('fresh.motor411 = false nulls torque/speed/dir/mode/status word', () => {
      const out = buildLiveValues(fullData(), { fresh: { motor411: false } });
      expect(out).toMatchObject({
        motor_torque_limit: null,
        motor_torque_value: null,
        motor_speed_rpm: null,
        motor_rotation_dir: null,
        motor_operation_mode: null,
        motor_status_word: null,
        // 412/413 still present; mcu_enable_state depends on battery status, not 411
        motor_ac_current_a: 85.3,
        radiator_temp_c: 41,
        mcu_enable_state: 'mcu_enabled',
      });
    });

    test('stale motor413 forces all motor fault flags false', () => {
      const out = buildLiveValues(fullData(), { fresh: { motor413: false } });
      expect(out.radiator_temp_c).toBeNull();
      expect(out.alarms.faults.has_any_motor_fault).toBe(false);
      expect(out.alarms.faults.fan_failure).toBe(false);
      expect(out.alarms.faults.encoder_failure).toBe(false);
    });

    test('stack voltage / current survive if either source frame is fresh', () => {
      const d = fullData();
      expect(buildLiveValues(d, { fresh: { bms12: false } }).stack_voltage_v).toBe(612.35);
      expect(buildLiveValues(d, { fresh: { bms12: false, bms3: false } }).stack_voltage_v).toBeNull();
      expect(buildLiveValues(d, { fresh: { bms3: false } }).battery_current_a).toBe(-45.3);
      expect(buildLiveValues(d, { fresh: { bms3: false, bms10: false } }).battery_current_a).toBeNull();
    });

    test('other groups gate on their own fresh keys', () => {
      const out = buildLiveValues(fullData(), {
        fresh: {
          btmsCmd: false,
          btmsStatus: false,
          dcdcStatus1: false,
          dcdcStatus2: false,
          air1: false,
          air2: false,
          imd: false,
          bms8: false,
          evcc1Control: false,
          evcc1EvseLimits: false,
          evcc1EvseStatus2: false,
        },
      });
      expect(out.btms_command_mode).toBeNull();
      expect(out.btms_status_mode).toBeNull();
      expect(out.dcdc_input_voltage_v).toBeNull();
      expect(out.dcdc_max_temp_c).toBeNull();
      expect(out.compressor_input_voltage_v).toBeNull();
      expect(out.compressor_output_voltage_v).toBeNull();
      expect(out.evcc1_pwr_stat).toBeNull();
      expect(out.evcc1_evse_max_volt_v).toBeNull();
      expect(out.evcc1_lock_status).toBeNull();
      const expected = allFalse(ALARM_KEYS);
      Object.assign(expected, { has_any_motor_fault: true, fan_failure: true, encoder_failure: true });
      expect(out.alarms.faults).toEqual(expected);
    });

    test('fresh values default to true when undefined/null', () => {
      const out = buildLiveValues(fullData(), { fresh: { bms2: undefined, motor411: null } });
      expect(out.soc_percent).toBe(78.46);
      expect(out.motor_speed_rpm).toBe(1501);
    });
  });

  describe('battery_status and mcu_enable_state', () => {
    const cases = [
      [2, 'Charging', 'mcu_disabled'],
      [3, 'Discharging', 'mcu_enabled'],
      [1, 'OFF', 'mcu_disabled'],
      [0, 'OFF', 'mcu_disabled'],
      ['3', 'Discharging', 'mcu_enabled'],
    ];
    test.each(cases)('BMS_STATE %p -> %p / %p', (state, status, mcu) => {
      const out = buildLiveValues({ bms1: { BMS_STATE: state } });
      expect(out.battery_status).toBe(status);
      expect(out.mcu_enable_state).toBe(mcu);
    });

    test('missing BMS_STATE -> null status, mcu_disabled', () => {
      const out = buildLiveValues({ bms1: {} });
      expect(out.battery_status).toBeNull();
      expect(out.mcu_enable_state).toBe('mcu_disabled');
    });

    test('stale bms1 -> null status, mcu_disabled', () => {
      const out = buildLiveValues({ bms1: { BMS_STATE: 3 } }, { fresh: { bms1: false } });
      expect(out.battery_status).toBeNull();
      expect(out.mcu_enable_state).toBe('mcu_disabled');
    });
  });

  describe('misc app quirks', () => {
    test('motor_status_word and rotation direction', () => {
      const out = (m) => buildLiveValues({ message411: m });
      expect(out({ St_motor: 0, N_motorSpeed: 0 }).motor_status_word).toBe('Stopped');
      expect(out({ St_motor: 0 }).motor_status_word).toBe('Stopped');
      expect(out({ St_motor: 2, N_motorSpeed: -10 }).motor_status_word).toBe('Running');
      expect(out({ N_motorSpeed: 100 }).motor_status_word).toBeNull();
      expect(out({ St_motorDirection: 2 }).motor_rotation_dir).toBe('reverse');
      expect(out({ St_motorDirection: 0 }).motor_rotation_dir).toBe('stopped');
      expect(out({ St_motorDirection: 3 }).motor_rotation_dir).toBeNull();
    });

    test('BTMS invalid / unknown enum strings map to null', () => {
      const out = buildLiveValues({
        btmsCommand: { mode: 'invalid', hvRequest: 0, chargeStatus: 'invalid', bmsHvRelayState: 'invalid' },
        btmsStatus: { tmsMode: 'self_circulation', hvRelayState: 'invalid', faultLevel: 'invalid' },
      });
      expect(out.btms_command_mode).toBeNull();
      expect(out.btms_hv_request).toBeNull();
      expect(out.btms_charge_status).toBeNull();
      expect(out.bms_hv_relay_state).toBeNull();
      expect(out.btms_status_mode).toBe(3);
      expect(out.btms_hv_relay_state).toBeNull();
      expect(out.alarms.faults.btms_fault_invalid).toBe(true);
    });

    test('dcdcVtgCur wins over status frames; falls back when absent', () => {
      const out = buildLiveValues({
        dcdcStatus1: { inputVoltageV: 600.04, inputCurrentA: 1 },
        dcdcStatus2: { outputVoltageV: 27.1, outputCurrentA: 9 },
      });
      expect(out.dcdc_input_voltage_v).toBe(600.04);
      expect(out.dcdc_output_current_a).toBe(9);
      const out2 = buildLiveValues({
        dcdcVtgCur: { Input_Voltage: 1 },
        dcdcStatus1: { inputVoltageV: 600 },
      });
      expect(out2.dcdc_input_voltage_v).toBe(1);
    });

    test('compressor flags require strict true', () => {
      const out = buildLiveValues({ airPumpStatus1: { hasFault: 1, faults: { overcurrent: 'true', short: true } } });
      expect(out.alarms.faults.compressor_has_fault).toBe(false);
      expect(out.alarms.faults.compressor_fault_overcurrent).toBe(false);
      expect(out.alarms.faults.compressor_fault_short).toBe(true);
    });
  });

  describe('odometer', () => {
    test('odo fields null by default', () => {
      const out = buildLiveValues(fullData(), { fresh: {} });
      expect(out.total_running_hrs).toBeNull();
      expect(out.last_trip_hrs).toBeNull();
      expect(out.total_kwh_consumed).toBeNull();
      expect(out.last_trip_kwh).toBeNull();
    });

    test('populated when opts.odo is passed', () => {
      const out = buildLiveValues({}, {
        odo: { totalRunMin: 1234.567, keyCycleRunMin: 59.99, totalKWh: 8765.4, keyCycleKWh: 0 },
      });
      expect(out.total_running_hrs).toBe('20:34:34');
      expect(out.last_trip_hrs).toBe('00:59:59');
      expect(out.total_kwh_consumed).toBe(8765.4);
      expect(out.last_trip_kwh).toBe(0);
    });

    test('interval edge cases match app minsToPgInterval', () => {
      const hrs = (m) => buildLiveValues({}, { odo: { totalRunMin: m } }).total_running_hrs;
      expect(hrs(0)).toBe('00:00:00');
      expect(hrs(-5)).toBe('00:00:00');
      expect(hrs(6000)).toBe('100:00:00');
      expect(hrs('12')).toBeNull();
      expect(hrs(NaN)).toBeNull();
      expect(hrs(null)).toBeNull();
    });
  });
});
