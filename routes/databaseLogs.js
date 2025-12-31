const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');

const router = express.Router();

/**
 * GET /api/database-logs/:vehicleId?date=YYYY-MM-DD
 *
 * Returns ALL raw telemetry records for the selected date in **local IST day**.
 * Uses AT TIME ZONE 'Asia/Kolkata' to match the calendar day as seen in India.
 */
router.get(
  '/:vehicleId',
  authenticateToken,
  checkPermission('analytics', 'read'),
  async (req, res) => {
    const { vehicleId } = req.params;
    const { date } = req.query;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ 
        error: 'Invalid or missing date. Use ?date=YYYY-MM-DD format' 
      });
    }

    try {
      const query = `
        SELECT 
          live_id,
          vehicle_master_id,
          recorded_at,
          soc_percent,
          stack_voltage_v,
          battery_status,
          max_voltage_v,
          min_voltage_v,
          avg_voltage_v,
          max_temp_c,
          min_temp_c,
          avg_temp_c,
          battery_current_a,
          charger_current_demand_a,
          charger_voltage_demand_v,
          cell_voltages,
          temp_sensors,
          motor_torque_limit,
          motor_torque_value,
          motor_speed_rpm,
          motor_rotation_dir,
          motor_operation_mode,
          mcu_enable_state,
          motor_ac_current_a,
          motor_ac_voltage_v,
          dc_side_voltage_v,
          motor_temp_c,
          mcu_temp_c,
          radiator_temp_c,
          total_running_hrs,
          last_trip_hrs,
          total_kwh_consumed,
          last_trip_kwh,
          alarms,
          dcdc_pri_a_mosfet_temp_c,
          dcdc_sec_ls_mosfet_temp_c,
          dcdc_sec_hs_mosfet_temp_c,
          dcdc_pri_c_mosfet_temp_c,
          dcdc_input_voltage_v,
          dcdc_input_current_a,
          dcdc_output_voltage_v,
          dcdc_output_current_a,
          dcdc_occurence_count
        FROM live_values
        WHERE vehicle_master_id = $1
          AND (recorded_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
        ORDER BY recorded_at ASC
      `;

      const { rows } = await db.query(query, [vehicleId, date]);

      if (rows.length === 0) {
        return res.json([]); // Frontend shows "No data"
      }

      // Clean formatting for frontend
      const formatted = rows.map(row => ({
        ...row,
        recorded_at: new Date(row.recorded_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        cell_voltages: row.cell_voltages || [],
        temp_sensors: row.temp_sensors || [],
        alarms: row.alarms || {},
        total_running_hrs: row.total_running_hrs ? String(row.total_running_hrs).slice(0, 8) : null,
        last_trip_hrs: row.last_trip_hrs ? String(row.last_trip_hrs).slice(0, 8) : null,
      }));

      res.json(formatted);
    } catch (err) {
      console.error('Database logs error:', err);
      res.status(500).json({ error: 'Server error while fetching logs' });
    }
  }
);

module.exports = router;