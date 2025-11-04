// routes/faults.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

// GET /api/faults/:id
router.get('/:id', authenticateToken, checkPermission('faults', 'read'), async (req, res) => {
  const { id } = req.params;
  const days = parseInt(req.query.days) || 30;

  try {
    const result = await db.query(
      `SELECT dtc_id, code, description, status, recorded_at
       FROM dtc_events
       WHERE vehicle_master_id = $1
         AND recorded_at >= NOW() - INTERVAL '${days} days'
       ORDER BY recorded_at DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error(`GET /faults/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;