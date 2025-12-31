const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/motor/analytics/:id
 *
 * Supported modes (priority order):
 * 1) ?date=YYYY-MM-DD              → single day
 * 2) ?from=YYYY-MM-DD&to=YYYY-MM-DD → date range
 * 3) ?days=30 (default)            → last N days
 *
 * NOTE:
 * - ORDER BY day DESC is preserved
 * - data[0] is always the latest day
 */
router.get(
  '/analytics/:id',
  authenticateToken,
  checkPermission('analytics', 'read'),
  async (req, res) => {
    const { id } = req.params;
    const { date, from, to, days } = req.query;

    let whereClause = `vehicle_master_id = $1`;
    const values = [id];
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

    try {
      const result = await db.query(
        `
        SELECT
          day,

          /* ===== DAILY PEAKS ===== */
          max_op_power_kw,
          max_op_torque_nm,
          max_op_current_a,
          max_motor_temp_c,

          /* ===== LAST TRIP PEAKS ===== */
          max_op_power_last_trip,
          max_op_torque_last_trip,
          max_op_current_last_trip,
          max_motor_temp_last_trip

        FROM motor_analytics_daily
        WHERE ${whereClause}
        ORDER BY day DESC
        `,
        values
      );

      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /motor/analytics/${id} failed`, {
        message: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
