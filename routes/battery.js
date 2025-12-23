// routes/battery.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

// GET /api/battery/analytics/:id?days=30
router.get(
  '/analytics/:id',
  authenticateToken,
  checkPermission('analytics', 'read'),
  async (req, res) => {
    const { id } = req.params;
    const days = Number.parseInt(req.query.days, 10) || 30;

    try {
      const result = await db.query(
        `
        SELECT
          day,

          -- cumulative metrics
          total_kwh_consumed,
          max_power_delivered_kw,
          max_op_dc_current_a,

          -- daily thermal
          max_cell_temp_c,
          avg_cell_temp_c,

          -- last trip metrics
          max_power_last_trip,
          kwh_last_trip,
          max_cell_temp_last_trip,
          avg_cell_temp_last_trip

        FROM battery_analytics_daily
        WHERE vehicle_master_id = $1
          AND day >= CURRENT_DATE - ($2 * INTERVAL '1 day')
        ORDER BY day DESC
        `,
        [id, days]
      );

      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /battery/analytics/${id} error: ${err.message}`, {
        stack: err.stack,
      });
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
