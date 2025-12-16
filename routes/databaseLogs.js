const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');

const router = express.Router();

/**
 * GET /api/database-logs/:vehicleId?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get(
  '/:vehicleId',
  authenticateToken,
  checkPermission('analytics', 'read'),
  async (req, res) => {
    const { vehicleId } = req.params;
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end dates required' });
    }

    const query = `
      WITH daily AS (
        SELECT
          DATE(recorded_at) AS day,

          MAX(total_kwh_consumed) - MIN(total_kwh_consumed)
            AS battery_kwh,

          SUM(
            COALESCE(motor_ac_voltage_v,0) *
            COALESCE(motor_ac_current_a,0)
          ) / 3600000.0
            AS motor_kwh,

          MIN(motor_temp_c) AS motor_temp_min,
          MAX(motor_temp_c) AS motor_temp_max,

          MIN(mcu_temp_c) AS mcu_temp_min,
          MAX(mcu_temp_c) AS mcu_temp_max,

          MIN(t) AS battery_temp_min,
          MAX(t) AS battery_temp_max,

          MIN(radiator_temp_c) AS oil_temp_min,
          MAX(radiator_temp_c) AS oil_temp_max,

          COUNT(*) FILTER (
            WHERE battery_current_a > 0
          ) AS charging_sessions

        FROM live_values
        LEFT JOIN LATERAL unnest(temp_sensors) t ON true
        WHERE vehicle_master_id = $1
          AND recorded_at >= $2
          AND recorded_at < ($3::date + INTERVAL '1 day')
        GROUP BY DATE(recorded_at)
        ORDER BY day
      )
      SELECT * FROM daily;
    `;

    const { rows } = await db.query(query, [
      vehicleId,
      start,
      end
    ]);

    res.json(rows);
  }
);

module.exports = router;
