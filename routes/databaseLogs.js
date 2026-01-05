// routes/database-logs.js

const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/database-logs/:id
 * ... (same comments as before)
 */
router.get(
  '/:id',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const { id } = req.params;
    let { date, period, start, end, cursor, full } = req.query;
    const isCustomer = req.user.role === 'customer';
    full = full === 'true';

    // ---------------- VALIDATION ----------------
    if (!id || isNaN(Number(id))) {
      return res.status(400).json([]);
    }

    if (!date && !period && !(start && end)) {
      return res.status(400).json({ error: 'Missing time range: provide date, period, or start/end' });
    }

    try {
      // ---------------- OWNERSHIP CHECK ----------------
      const ownership = await db.query(
        `
        SELECT 1
        FROM vehicle_master vm
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        WHERE vm.vehicle_master_id = $1
          AND ($2::int IS NULL OR cm.user_id = $2)
        `,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (ownership.rows.length === 0) {
        logger.warn(`Access denied: user ${req.user.email || 'unknown'} tried logs for vehicle ${id}`);
        return res.status(403).json([]);
      }

      // ---------------- BUILD TIME FILTER ----------------
      let timeClause = '';
      const params = [Number(id)];

      if (period) {
        const nowIST = "timezone('Asia/Kolkata', now())";

        switch (period) {
          case 'today':
            timeClause = `recorded_at >= ${nowIST}::date AND recorded_at < ${nowIST}::date + interval '1 day'`;
            break;
          case 'week':
            timeClause = `recorded_at >= ${nowIST}::date - interval '6 days'`;
            break;
          case 'month':
            timeClause = `recorded_at >= ${nowIST}::date - interval '29 days'`;
            break;
          case 'all':
            timeClause = 'TRUE';
            break;
          default:
            return res.status(400).json({ error: 'Invalid period: use today, week, month, or all' });
        }
      } else if (start && end) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
          return res.status(400).json({ error: 'Invalid start/end date format' });
        }
        params.push(start, end);
        timeClause = `
          recorded_at >= timezone('Asia/Kolkata', $2::date)
          AND recorded_at < timezone('Asia/Kolkata', $3::date + interval '1 day')
        `;
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ error: 'Invalid date format' });
        }
        params.push(date);
        timeClause = `
          recorded_at >= timezone('Asia/Kolkata', $2::date)
          AND recorded_at < timezone('Asia/Kolkata', $2::date + interval '1 day')
        `;
      }

      // ---------------- UPDATED QUERY WITH ALL NEW FIELDS ----------------
      let query = `
        SELECT
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
          to_char(total_running_hrs, 'HH24:MI:SS') AS total_running_hrs,
          to_char(last_trip_hrs, 'HH24:MI:SS') AS last_trip_hrs,
          total_kwh_consumed,
          last_trip_kwh,

          -- DC-DC
          dcdc_pri_a_mosfet_temp_c,
          dcdc_sec_ls_mosfet_temp_c,
          dcdc_sec_hs_mosfet_temp_c,
          dcdc_pri_c_mosfet_temp_c,
          dcdc_input_voltage_v,
          dcdc_input_current_a,
          dcdc_output_voltage_v,
          dcdc_output_current_a,
          dcdc_occurence_count,

          -- BTMS / BMS Thermal
          btms_command_mode,
          btms_hv_request,
          btms_charge_status,
          bms_hv_relay_state,
          btms_target_temp_c,
          bms_pack_voltage_v,
          bms_life_counter,
          btms_command_crc,
          btms_status_mode,
          btms_hv_relay_state,
          btms_inlet_temp_c,
          btms_outlet_temp_c,
          btms_demand_power_kw,

          -- Motor Raw / Inverter
          motor_status_word,
          motor_freq_raw,
          motor_total_wattage_w,
          motor_dc_input_voltage_raw,
          motor_ac_output_voltage_raw

        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${timeClause}
      `;

      if (!full && cursor) {
        params.push(cursor);
        query += ` AND recorded_at > $${params.length}::timestamptz`;
      }

      query += ` ORDER BY recorded_at ASC`;

      if (!full) {
        query += ` LIMIT 200`;
      }

      const result = await db.query(query, params);
      const rows = result?.rows || [];

      // ---------------- FORMAT RESPONSE ----------------
      const formatted = rows.map(row => ({
        ...row,
        recorded_at_raw: row.recorded_at.toISOString(),
        recorded_at: row.recorded_at.toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
        cell_voltages: row.cell_voltages ?? [],
        temp_sensors: row.temp_sensors ?? [],
        total_running_hrs: row.total_running_hrs,
        last_trip_hrs: row.last_trip_hrs,
      }));

      if (!full) {
        res.set('X-Has-More', rows.length === 200 ? 'true' : 'false');
      }

      return res.status(200).json(formatted);

    } catch (err) {
      logger.error(`Database logs error (vehicle ${id}): ${err.message}`);
      return res.status(500).json([]);
    }
  }
);

module.exports = router;