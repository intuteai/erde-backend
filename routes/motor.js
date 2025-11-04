// routes/motor.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

// GET /api/motor/analytics/:id
router.get('/analytics/:id', authenticateToken, checkPermission('analytics', 'read'), async (req, res) => {
  const { id } = req.params;
  const days = parseInt(req.query.days) || 30;

  try {
    const result = await db.query(
      `SELECT day, max_op_power_kw, max_op_torque_nm, max_motor_temp_c
       FROM motor_analytics_daily
       WHERE vehicle_master_id = $1
         AND day >= CURRENT_DATE - INTERVAL '${days} days'
       ORDER BY day DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error(`GET /motor/analytics/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;