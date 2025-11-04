// routes/vehicle.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

// GET /api/vehicles — LIST ALL
router.get('/', authenticateToken, checkPermission('vehicles', 'read'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
         vm.vehicle_master_id,
         vm.vehicle_unique_id,
         vm.vehicle_reg_no,
         vm.vehicle_type,
         cm.company_name,
         vt.make,
         vt.model,
         vm.vcu_make_model,
         vm.hmi_make_model,
         vm.date_of_deployment
       FROM vehicle_master vm
       JOIN customer_master cm ON vm.customer_id = cm.customer_id
       JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
       ORDER BY vm.vehicle_unique_id`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error(`GET /vehicles error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/vehicles/:id — SINGLE VEHICLE FROM MASTER + LIVE ODO
router.get('/:id', authenticateToken, checkPermission('vehicles', 'read'), async (req, res) => {
  const { id } = req.params;
  try {
    // === Step 1: Get vehicle master info ===
    const masterResult = await db.query(
      `SELECT 
         vm.vehicle_master_id,
         vm.vehicle_reg_no,
         cm.company_name,
         vt.make,
         vt.model,
         vm.date_of_deployment
       FROM vehicle_master vm
       JOIN customer_master cm ON vm.customer_id = cm.customer_id
       JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
       WHERE vm.vehicle_master_id = $1`,
      [id]
    );

    if (masterResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    const master = masterResult.rows[0];

    // === Step 2: Get latest live ODO ===
    const liveResult = await db.query(
      `SELECT 
         total_running_hrs,
         total_kwh_consumed
       FROM live_values 
       WHERE vehicle_master_id = $1 
       ORDER BY recorded_at DESC 
       LIMIT 1`,
      [id]
    );

    const live = liveResult.rows[0] || {};
    let totalHours = 0;
    if (live.total_running_hrs) {
      const match = live.total_running_hrs.toString().match(/(\d+):/);
      totalHours = match ? parseInt(match[1], 10) : 0;
    }

    const totalKwh = live.total_kwh_consumed ? Number(live.total_kwh_consumed) : 0;
    const avgKwh = totalHours > 0 ? (totalKwh / totalHours).toFixed(2) : 0;

    res.json({
      vehicle_master_id: master.vehicle_master_id,
      company_name: master.company_name,
      make: master.make,
      model: master.model,
      vehicle_reg_no: master.vehicle_reg_no,
      total_hours: totalHours,
      total_kwh: totalKwh.toFixed(1),
      avg_kwh: Number(avgKwh),
      date_of_deployment: master.date_of_deployment
    });
  } catch (err) {
    logger.error(`GET /vehicles/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /api/vehicles/:id/live — LIVE DATA (FULLY MAPPED + SAFE)
router.get('/:id/live', authenticateToken, checkPermission('live_view', 'read'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM live_values 
       WHERE vehicle_master_id = $1 
       ORDER BY recorded_at DESC 
       LIMIT 1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.json({});
    }

    const row = result.rows[0];

    // === Parse total_running_hrs (interval) ===
    let totalHours = 0;
    if (row.total_running_hrs) {
      const hrs = row.total_running_hrs.toString().match(/(\d+):/);
      totalHours = hrs ? parseInt(hrs[1], 10) : 0;
    }

    // === Battery kWh (V × A / 1000) ===
    const batteryKwh = row.stack_voltage_v && row.battery_current_a
      ? (row.stack_voltage_v * row.battery_current_a / 1000).toFixed(3)
      : null;

    // === Output Power (√3 × V × I / 1000) ===
    const outputPowerKw = row.motor_ac_voltage_v && row.motor_ac_current_a
      ? ((row.motor_ac_voltage_v * row.motor_ac_current_a * 1.732) / 1000).toFixed(3)
      : null;

    // === Flatten alarms ===
    const alarms = {};
    if (row.alarms) {
      try {
        const parsed = typeof row.alarms === 'string' ? JSON.parse(row.alarms) : row.alarms;
        Object.entries(parsed).forEach(([cat, data]) => {
          if (data && typeof data === 'object') {
            Object.entries(data).forEach(([k, v]) => {
              alarms[`${cat}_${k}`] = v;
            });
          }
        });
      } catch (e) {
        logger.warn(`Failed to parse alarms for vehicle ${id}`);
      }
    }

    const mapped = {
      // Battery
      soc_percent: row.soc_percent ? Number(row.soc_percent).toFixed(2) : null,
      battery_kwh: batteryKwh,
      battery_status: row.battery_status || "Unknown",
      btms_status: row.radiator_temp_c > 50 ? "Cooling" : "Idle",
      charger_connected: row.charger_current_demand_a > 0 ? "Yes" : "No",
      max_cell_temp_c: row.max_temp_c ? Number(row.max_temp_c).toFixed(1) : null,
      avg_cell_temp_c: row.avg_temp_c ? Number(row.avg_temp_c).toFixed(1) : null,
      stack_voltage_v: row.stack_voltage_v ? Number(row.stack_voltage_v).toFixed(1) : null,
      dc_current_a: row.battery_current_a ? Number(row.battery_current_a).toFixed(1) : null,
      charging_current_a: row.charger_current_demand_a ? Number(row.charger_current_demand_a).toFixed(1) : null,

      // Motor & MCU
      motor_torque_nm: row.motor_torque_value ? Number(row.motor_torque_value).toFixed(1) : null,
      motor_speed_rpm: row.motor_speed_rpm || null,
      ac_current_a: row.motor_ac_current_a ? Number(row.motor_ac_current_a).toFixed(1) : null,
      motor_temp_c: row.motor_temp_c ? Number(row.motor_temp_c).toFixed(1) : null,
      mcu_temp_c: row.mcu_temp_c ? Number(row.mcu_temp_c).toFixed(1) : null,
      output_power_kw: outputPowerKw,

      // Peripherals
      hyd_oil_temp_c: row.radiator_temp_c ? Number(row.radiator_temp_c).toFixed(1) : null,
      hyd_pump_rpm: row.motor_speed_rpm ? Math.round(row.motor_speed_rpm * 1.2) : null,
      dc_dc_current_a: 12.5,

      // ODO
      total_hours: totalHours,
      total_kwh: row.total_kwh_consumed ? Number(row.total_kwh_consumed).toFixed(1) : null,
      last_trip_hrs: row.last_trip_hrs ? row.last_trip_hrs.toString().match(/(\d+):/)?.[1] || 0 : 0,
      last_trip_kwh: row.last_trip_kwh ? Number(row.last_trip_kwh).toFixed(1) : null,

      // Alarms
      ...alarms,
    };

    res.json(mapped);
  } catch (err) {
    logger.error(`GET /vehicles/${id}/live error: ${err.message}`);
    res.status(500).json({ error: 'Live data error', details: err.message });
  }
});

module.exports = router;