const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

/* ========================= READ DTC EVENTS (HISTORY) ========================= */
/**
 * GET /api/faults/:id
 *
 * Returns full DTC history for the vehicle.
 * Events are ordered by when they were activated (most recent first).
 *
 * Optional query params (for future filtering if needed):
 *   ?days=30     → last 30 days
 *   ?date=2025-12-25 → events activated on that exact day
 */
router.get(
  '/:id',
  authenticateToken,
  checkPermission('faults', 'read'),
  async (req, res) => {
    const { id: vehicleId } = req.params;
    const { days, date } = req.query;

    try {
      let query = `
        SELECT
          dtc_id,
          code,
          description,
          status,
          activated_at,
          cleared_at
        FROM dtc_events
        WHERE vehicle_master_id = $1
      `;
      const values = [vehicleId];
      let paramIndex = 2;

      if (date) {
        // Filter by exact activation date (00:00 to 23:59:59)
        query += `
          AND activated_at::date = $${paramIndex}::date
        `;
        values.push(date);
        paramIndex++;
      } else if (days) {
        // Optional: last N days based on activation time
        const dayCount = Math.max(1, Number.parseInt(days, 10));
        query += `
          AND activated_at >= NOW() - ($${paramIndex} || ' days')::interval
        `;
        values.push(dayCount);
      }

      query += `
        ORDER BY activated_at DESC
      `;

      const result = await db.query(query, values);
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /faults/${vehicleId} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;