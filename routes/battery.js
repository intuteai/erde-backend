const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Same ownership-check pattern as routes/vehicle.js's checkVehicleAccess —
 * admins always pass, customers are restricted to vehicles under their
 * own user_id. Without this, any authenticated user with 'analytics' read
 * permission (which customers legitimately have, for their own vehicles)
 * could view any OTHER customer's battery data just by changing :id.
 */
const checkVehicleAccess = async (vehicleId, userId, isCustomer) => {
  const result = await db.query(
    `
    SELECT EXISTS(
      SELECT 1
      FROM vehicle_master vm
      JOIN customer_master cm ON vm.customer_id = cm.customer_id
      WHERE vm.vehicle_master_id = $1
        AND ($2::int IS NULL OR cm.user_id = $2)
    ) AS allowed
    `,
    [vehicleId, isCustomer ? userId : null]
  );
  return result.rows[0]?.allowed === true;
};

/**
 * GET /api/battery/analytics/:id
 *
 * Supported modes (priority order):
 * 1) ?date=YYYY-MM-DD               → single day
 * 2) ?from=YYYY-MM-DD&to=YYYY-MM-DD → date range
 * 3) ?days=30 (default)             → last N days
 *
 * NOTES:
 * - ORDER BY day DESC is preserved
 * - data[0] is always the latest day
 * - daily values are returned as-is (no suppression)
 */
router.get(
  '/analytics/:id',
  authenticateToken,
  checkPermission('analytics', 'read'),
  async (req, res) => {
    const { id } = req.params;
    const { date, from, to, days } = req.query;

    const vehicleId = parseInt(id, 10);
    if (!Number.isFinite(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    try {
      const isCustomer = req.user.role === 'customer';
      const allowed = await checkVehicleAccess(vehicleId, req.user.user_id, isCustomer);
      if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      let whereClause = `vehicle_master_id = $1`;
      const values = [vehicleId];
      let idx = 2;

      /* ===== SINGLE DATE ===== */
      if (date) {
        whereClause += ` AND day = $${idx}`;
        values.push(date);
      }

      /* ===== DATE RANGE ===== */
      else if (from && to) {
        whereClause += ` AND day BETWEEN $${idx} AND $${idx + 1}`;
        values.push(from, to);
      }

      /* ===== DEFAULT: LAST N DAYS ===== */
      else {
        const safeDays = Number.isInteger(Number(days)) ? Number(days) : 30;
        whereClause += ` AND day >= CURRENT_DATE - ($${idx} * INTERVAL '1 day')`;
        values.push(safeDays);
      }

      const result = await db.query(
        `
        SELECT
          day,

          /* ===== DAILY ENERGY & ELECTRICAL ===== */
          total_kwh_consumed,
          max_power_delivered_kw,
          max_op_dc_current_a,

          /* ===== DAILY THERMAL ===== */
          max_cell_temp_c,
          avg_cell_temp_c,

          /* ===== LAST TRIP METRICS ===== */
          max_power_last_trip,
          kwh_last_trip,
          max_cell_temp_last_trip,
          avg_cell_temp_last_trip

        FROM battery_analytics_daily
        WHERE ${whereClause}
        ORDER BY day DESC
        `,
        values
      );

      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /battery/analytics/${id} failed`, {
        message: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
