// routes/vehicle.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

/* ============================================================
   HELPERS
============================================================ */

// Convert PG interval -> hours (safe, no guessing)
const intervalToHours = (interval) => {
  if (!interval) return null;
  const { days = 0, hours = 0, minutes = 0, seconds = 0 } = interval;
  return days * 24 + hours + minutes / 60 + seconds / 3600;
};

// Preserve 0, drop only null/undefined
const val = (v) => (v === null || v === undefined ? null : v);

// Flatten nested alarms JSON safely
const flattenAlarms = (alarms, out = {}) => {
  if (!alarms || typeof alarms !== 'object') return out;

  for (const [key, value] of Object.entries(alarms)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenAlarms(value, out);
    } else {
      out[`alarms_${key}`] = Boolean(value);
    }
  }
  return out;
};

/* ============================================================
   GET /api/vehicles — LIST ALL
============================================================ */
router.get(
  '/',
  authenticateToken,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    try {
      const result = await db.query(
        `
        SELECT 
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
        ORDER BY vm.vehicle_unique_id
        `
      );
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /vehicles error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id — MASTER + ODO SUMMARY
============================================================ */
router.get(
  '/:id',
  authenticateToken,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const masterResult = await db.query(
        `
        SELECT 
          vm.vehicle_master_id,
          vm.vehicle_reg_no,
          cm.company_name,
          vt.make,
          vt.model,
          vm.date_of_deployment
        FROM vehicle_master vm
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
        WHERE vm.vehicle_master_id = $1
        `,
        [id]
      );

      if (!masterResult.rows.length) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }

      const liveResult = await db.query(
        `
        SELECT total_running_hrs, total_kwh_consumed
        FROM live_values
        WHERE vehicle_master_id = $1
        ORDER BY recorded_at DESC
        LIMIT 1
        `,
        [id]
      );

      const live = liveResult.rows[0] || {};

      res.json({
        vehicle_master_id: masterResult.rows[0].vehicle_master_id,
        company_name: masterResult.rows[0].company_name,
        make: masterResult.rows[0].make,
        model: masterResult.rows[0].model,
        vehicle_reg_no: masterResult.rows[0].vehicle_reg_no,
        total_hours: intervalToHours(live.total_running_hrs),
        total_kwh: val(live.total_kwh_consumed),
        date_of_deployment: masterResult.rows[0].date_of_deployment,
      });
    } catch (err) {
      logger.error(`GET /vehicles/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/live — LIVE VIEW (DB-TRUTH ONLY)
============================================================ */
router.get(
  '/:id/live',
  authenticateToken,
  checkPermission('live_view', 'read'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const result = await db.query(
        `
        SELECT *
        FROM live_values
        WHERE vehicle_master_id = $1
        ORDER BY recorded_at DESC
        LIMIT 1
        `,
        [id]
      );

      if (!result.rows.length) return res.json({});

      const r = result.rows[0];

      const response = {
        /* ================= BATTERY ================= */
        soc_percent: val(r.soc_percent),
        battery_status: val(r.battery_status),
        stack_voltage_v: val(r.stack_voltage_v),
        dc_current_a: val(r.battery_current_a),
        charging_current_a: val(r.charger_current_demand_a),

        /* ================= MODULES ================= */
        cell_voltages: val(r.cell_voltages),
        temp_sensors: val(r.temp_sensors),
        max_cell_temp_c: val(r.max_temp_c),
        avg_cell_temp_c: val(r.avg_temp_c),
        min_cell_temp_c: val(r.min_temp_c),

        /* ================= MOTOR & MCU ================= */
        motor_torque_nm: val(r.motor_torque_value),
        motor_torque_limit: val(r.motor_torque_limit),
        motor_speed_rpm: val(r.motor_speed_rpm),
        motor_operation_mode: val(r.motor_operation_mode),
        motor_rotation_dir: val(r.motor_rotation_dir),
        ac_current_a: val(r.motor_ac_current_a),
        motor_ac_voltage_v: val(r.motor_ac_voltage_v),
        motor_temp_c: val(r.motor_temp_c),
        mcu_temp_c: val(r.mcu_temp_c),
        mcu_enable_state: val(r.mcu_enable_state),

        /* ================= PERIPHERALS ================= */
        radiator_temp_c: val(r.radiator_temp_c),

        /* ================= ODO / TRIP ================= */
        total_hours: intervalToHours(r.total_running_hrs),
        last_trip_hrs: intervalToHours(r.last_trip_hrs),
        total_kwh: val(r.total_kwh_consumed),
        last_trip_kwh: val(r.last_trip_kwh),
      };

      /* ============ SAFE DERIVATION: DC POWER ============ */
      if (r.stack_voltage_v != null && r.battery_current_a != null) {
        response.output_power_kw =
          (r.stack_voltage_v * r.battery_current_a) / 1000;
      } else {
        response.output_power_kw = null;
      }

      /* ================= ALARMS ================= */
      Object.assign(response, flattenAlarms(r.alarms));

      res.json(response);
    } catch (err) {
      logger.error(`GET /vehicles/${id}/live error: ${err.message}`);
      res.status(500).json({ error: 'Live data error' });
    }
  }
);

module.exports = router;
