// utils/formatLiveData.js

const toNumber = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const intervalToHours = (interval) => {
  if (!interval) return null;
  const { days = 0, hours = 0, minutes = 0, seconds = 0 } = interval;
  return days * 24 + hours + minutes / 60 + seconds / 3600;
};

const flattenAlarms = (alarms, out = {}) => {
  if (!alarms || typeof alarms !== 'object') return out;

  for (const [k, v] of Object.entries(alarms)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenAlarms(v, out);
    } else {
      out[`alarms_${k}`] = Boolean(v);
    }
  }
  return out;
};

function formatLiveData(row) {
  if (!row) return {};

  const r = row;

  const data = {
    // Timestamp
    recorded_at: r.recorded_at ? r.recorded_at.toISOString() : null,

    // === Battery Basics ===
    soc_percent: toNumber(r.soc_percent),
    battery_status: r.battery_status ?? null,
    stack_voltage_v: toNumber(r.stack_voltage_v),
    dc_current_a: toNumber(r.battery_current_a),
    charging_current_a: toNumber(r.charger_current_demand_a),
    charger_voltage_demand_v: toNumber(r.charger_voltage_demand_v),

    max_voltage_v: toNumber(r.max_voltage_v),
    min_voltage_v: toNumber(r.min_voltage_v),
    avg_voltage_v: toNumber(r.avg_voltage_v),
    max_temp_c: toNumber(r.max_temp_c),
    min_temp_c: toNumber(r.min_temp_c),
    avg_temp_c: toNumber(r.avg_temp_c),

    // === Module Arrays ===
    temp_sensors: Array.isArray(r.temp_sensors)
      ? r.temp_sensors.map(toNumber)
      : [],

    cell_voltages: Array.isArray(r.cell_voltages)
      ? r.cell_voltages.map(toNumber)
      : [],

    // === Motor & Inverter ===
    motor_torque_nm: toNumber(r.motor_torque_value),
    motor_torque_limit: toNumber(r.motor_torque_limit),
    motor_operation_mode: r.motor_operation_mode ?? null,
    motor_speed_rpm: toNumber(r.motor_speed_rpm),
    motor_rotation_dir: r.motor_rotation_dir ?? null,
    ac_current_a: toNumber(r.motor_ac_current_a),
    motor_ac_voltage_v: toNumber(r.motor_ac_voltage_v),
    dc_side_voltage_v: toNumber(r.dc_side_voltage_v),
    mcu_enable_state: r.mcu_enable_state?.trim() || null,
    motor_temp_c: toNumber(r.motor_temp_c),
    mcu_temp_c: toNumber(r.mcu_temp_c),
    radiator_temp_c: toNumber(r.radiator_temp_c),

    // === New Motor Raw Fields ===
    motor_status_word: toNumber(r.motor_status_word),
    motor_freq_raw: toNumber(r.motor_freq_raw),
    motor_total_wattage_w: toNumber(r.motor_total_wattage_w),
    motor_dc_input_voltage_raw: toNumber(r.motor_dc_input_voltage_raw),
    motor_ac_output_voltage_raw: toNumber(r.motor_ac_output_voltage_raw),

    // === Odometer & Energy ===
    total_hours: intervalToHours(r.total_running_hrs),
    last_trip_hrs: intervalToHours(r.last_trip_hrs),
    total_kwh: toNumber(r.total_kwh_consumed),
    last_trip_kwh: toNumber(r.last_trip_kwh),

    // === DC–DC Converter ===
    dcdc_input_voltage_v: toNumber(r.dcdc_input_voltage_v),
    dcdc_input_current_a: toNumber(r.dcdc_input_current_a),
    dcdc_output_voltage_v: toNumber(r.dcdc_output_voltage_v),
    dcdc_output_current_a: toNumber(r.dcdc_output_current_a),
    dcdc_pri_a_mosfet_temp_c: toNumber(r.dcdc_pri_a_mosfet_temp_c),
    dcdc_pri_c_mosfet_temp_c: toNumber(r.dcdc_pri_c_mosfet_temp_c),
    dcdc_sec_ls_mosfet_temp_c: toNumber(r.dcdc_sec_ls_mosfet_temp_c),
    dcdc_sec_hs_mosfet_temp_c: toNumber(r.dcdc_sec_hs_mosfet_temp_c),
    dcdc_occurrence_count: toNumber(r.dcdc_occurence_count),

    // === BTMS / BMS Thermal Management ===
    btms_command_mode: toNumber(r.btms_command_mode),
    btms_hv_request: toNumber(r.btms_hv_request),
    btms_charge_status: toNumber(r.btms_charge_status),
    bms_hv_relay_state: toNumber(r.bms_hv_relay_state),
    btms_target_temp_c: toNumber(r.btms_target_temp_c),
    bms_pack_voltage_v: toNumber(r.bms_pack_voltage_v),
    bms_life_counter: toNumber(r.bms_life_counter),
    btms_command_crc: toNumber(r.btms_command_crc),
    btms_status_mode: toNumber(r.btms_status_mode),
    btms_hv_relay_state: toNumber(r.btms_hv_relay_state),
    btms_inlet_temp_c: toNumber(r.btms_inlet_temp_c),
    btms_outlet_temp_c: toNumber(r.btms_outlet_temp_c),
    btms_demand_power_kw: toNumber(r.btms_demand_power_kw),

    // Calculated field (kept from original)
    output_power_kw: null,
  };

  // Power calculation: Battery stack power in kW
  if (data.stack_voltage_v != null && data.dc_current_a != null) {
    data.output_power_kw = (data.stack_voltage_v * Math.abs(data.dc_current_a)) / 1000; // Use abs for discharge
  }

  // Flatten alarms into top-level boolean flags
  Object.assign(data, flattenAlarms(r.alarms));

  return data;
}

module.exports = { formatLiveData };