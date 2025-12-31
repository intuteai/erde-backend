const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();

/* ========================= HELPERS ========================= */

/**
 * Convert alarm key → stable DTC code
 * Example: "motor_over_temperature_fault" → "MOTOR_OVER_TEMPERATURE_FAULT"
 */
const normalizeDtcCode = (key) =>
  String(key).toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/* ========================= WRITE DTC EVENTS ========================= */
/**
 * POST /api/faults/:id
 *
 * Expected body:
 * {
 *   "alarms": {
 *     "faults": { ...boolean flags... }
 *   }
 * }
 */
router.post(
  '/:id',
  authenticateToken,
  checkPermission('faults', 'write'),
  async (req, res) => {
    const { id: vehicleId } = req.params;
    const faults = req.body?.alarms?.faults;

    if (!faults || typeof faults !== 'object') {
      return res.status(400).json({
        error: 'Invalid payload. Expected alarms.faults object',
      });
    }

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      for (const [key, value] of Object.entries(faults)) {
        if (typeof value !== 'boolean') continue;

        const code = normalizeDtcCode(key);
        const description = `Alarm flag: ${key}`;

        if (value === true) {
          // Activate fault if not already active
          await client.query(
            `
            INSERT INTO dtc_events (vehicle_master_id, code, description, status)
            SELECT $1, $2, $3, 'ACTIVE'
            WHERE NOT EXISTS (
              SELECT 1 FROM dtc_events
              WHERE vehicle_master_id = $1
                AND code = $2
                AND status = 'ACTIVE'
            )
            ON CONFLICT DO NOTHING
            `,
            [vehicleId, code, description]
          );
        } else {
          // Clear active fault
          await client.query(
            `
            UPDATE dtc_events
            SET status = 'CLEARED', cleared_at = NOW()
            WHERE vehicle_master_id = $1
              AND code = $2
              AND status = 'ACTIVE'
            `,
            [vehicleId, code]
          );
        }
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`POST /faults/${vehicleId} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
    }
  }
);

/* ========================= READ DTC EVENTS ========================= */
/**
 * GET /api/faults/:id
 *
 * Supports:
 *   ?days=30     → last 30 days (default)
 *   ?date=2025-12-25 → faults from that exact day (00:00 to 23:59:59)
 */
router.get(
  '/:id',
  authenticateToken,
  checkPermission('faults', 'read'),
  async (req, res) => {
    const { id } = req.params;
    const { days, date } = req.query;

    try {
      let query;
      let values;

      if (date) {
        // Exact day filter: from 00:00 to 23:59:59 of given date
        const targetDate = date; // Expected format: YYYY-MM-DD

        query = `
          SELECT
            dtc_id,
            code,
            description,
            status,
            recorded_at
          FROM dtc_events
          WHERE vehicle_master_id = $1
            AND recorded_at::date = $2::date
          ORDER BY recorded_at DESC
        `;
        values = [id, targetDate];
      } else {
        // Default: last N days
        const dayCount = Math.max(1, Number.parseInt(days, 10) || 30);

        query = `
          SELECT
            dtc_id,
            code,
            description,
            status,
            recorded_at
          FROM dtc_events
          WHERE vehicle_master_id = $1
            AND recorded_at >= NOW() - ($2 || ' days')::interval
          ORDER BY recorded_at DESC
        `;
        values = [id, dayCount];
      }

      const result = await db.query(query, values);
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /faults/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;