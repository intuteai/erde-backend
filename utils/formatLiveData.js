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
    soc_percent: toNumber(r.soc_percent),
    battery_status: r.battery_status ?? null,
    stack_voltage_v: toNumber(r.stack_voltage_v),
    dc_current_a: toNumber(r.battery_current_a),
    charging_current_a: toNumber(r.charger_current_demand_a),

    temp_sensors: (r.temp_sensors || []).map(toNumber),
    cell_voltages: (r.cell_voltages || []).map(toNumber),

    motor_torque_nm: toNumber(r.motor_torque_value),
    motor_torque_limit: toNumber(r.motor_torque_limit),
    motor_operation_mode: r.motor_operation_mode ?? null,
    motor_speed_rpm: toNumber(r.motor_speed_rpm),
    motor_rotation_dir: r.motor_rotation_dir ?? null,
    ac_current_a: toNumber(r.motor_ac_current_a),
    motor_ac_voltage_v: toNumber(r.motor_ac_voltage_v),
    mcu_enable_state: r.mcu_enable_state
      ? r.mcu_enable_state.toLowerCase().trim() === 'enabled'
      : null,
    motor_temp_c: toNumber(r.motor_temp_c),
    mcu_temp_c: toNumber(r.mcu_temp_c),

    radiator_temp_c: toNumber(r.radiator_temp_c),

    total_hours: intervalToHours(r.total_running_hrs),
    last_trip_hrs: intervalToHours(r.last_trip_hrs),
    total_kwh: toNumber(r.total_kwh_consumed),
    last_trip_kwh: toNumber(r.last_trip_kwh),

    dcdc_input_voltage_v: toNumber(r.dcdc_input_voltage_v),
    dcdc_input_current_a: toNumber(r.dcdc_input_current_a),
    dcdc_output_voltage_v: toNumber(r.dcdc_output_voltage_v),
    dcdc_output_current_a: toNumber(r.dcdc_output_current_a),
    dcdc_pri_a_mosfet_temp_c: toNumber(r.dcdc_pri_a_mosfet_temp_c),
    dcdc_pri_c_mosfet_temp_c: toNumber(r.dcdc_pri_c_mosfet_temp_c),
    dcdc_sec_ls_mosfet_temp_c: toNumber(r.dcdc_sec_ls_mosfet_temp_c),
    dcdc_sec_hs_mosfet_temp_c: toNumber(r.dcdc_sec_hs_mosfet_temp_c),
    dcdc_occurrence_count: toNumber(r.dcdc_occurence_count) ?? null,

    output_power_kw: null,
  };

  // Calculate output power
  if (data.stack_voltage_v != null && data.dc_current_a != null) {
    data.output_power_kw = (data.stack_voltage_v * data.dc_current_a) / 1000;
  }

  // Flatten alarms
  Object.assign(data, flattenAlarms(r.alarms));

  return data;
}

module.exports = { formatLiveData };