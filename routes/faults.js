const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Same ownership-check pattern as routes/vehicle.js's checkVehicleAccess —
 * admins always pass, customers are restricted to vehicles under their
 * own user_id. Without this, any authenticated user with 'faults' read
 * permission (which customers legitimately have, for their own vehicles)
 * could view any OTHER customer's fault/DTC history just by changing :id.
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
    const { id: rawId } = req.params;
    const { days, date } = req.query;

    const vehicleId = parseInt(rawId, 10);
    if (!Number.isFinite(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    try {
      const isCustomer = req.user.role === 'customer';
      const allowed = await checkVehicleAccess(vehicleId, req.user.user_id, isCustomer);
      if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
      }

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