const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

/* -------------------------------------------------------
   Shared helper: ownership + time filter (same as logs)
------------------------------------------------------- */
async function buildTimeFilter(req, vehicleId) {
  let { date, period, start, end } = req.query;
  const params = [Number(vehicleId)];
  let timeClause = '';

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
        throw new Error('Invalid period');
    }
  } else if (start && end) {
    params.push(start, end);
    timeClause = `
      recorded_at >= timezone('Asia/Kolkata', $2::date)
      AND recorded_at < timezone('Asia/Kolkata', $3::date + interval '1 day')
    `;
  } else if (date) {
    params.push(date);
    timeClause = `
      recorded_at >= timezone('Asia/Kolkata', $2::date)
      AND recorded_at < timezone('Asia/Kolkata', $2::date + interval '1 day')
    `;
  } else {
    throw new Error('Missing time range');
  }

  return { timeClause, params };
}

/* -------------------------------------------------------
   CSV-safe IST timestamp formatting
   → Outputs: "2026-01-23 14:35:22"  (quoted when used)
------------------------------------------------------- */
function formatRecordedAtForCSV(ts) {
  return ts.toLocaleString('sv-SE', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
  }).replace('T', ' ');
}

const CSV_SAFE_TIMESTAMP = (ts) => `"${formatRecordedAtForCSV(ts)}"`;

/* -------------------------------------------------------
   CELL VOLTAGE EXPORT
------------------------------------------------------- */
router.get(
  '/:id/export/cells',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const { id } = req.params;
    const isCustomer = req.user.role === 'customer';

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    try {
      // Ownership check
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

      if (!ownership.rows.length) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { timeClause, params } = await buildTimeFilter(req, id);

      const result = await db.query(
        `
        SELECT recorded_at, cell_modules
        FROM live_values
        WHERE vehicle_master_id = $1
          AND cell_modules IS NOT NULL
          AND ${timeClause}
        ORDER BY recorded_at ASC
        `,
        params
      );

      const rows = result.rows || [];

      // Determine max structure
      let maxModules = 0;
      let maxCells = 0;
      for (const r of rows) {
        if (Array.isArray(r.cell_modules)) {
          maxModules = Math.max(maxModules, r.cell_modules.length);
          r.cell_modules.forEach(m =>
            maxCells = Math.max(maxCells, Array.isArray(m) ? m.length : 0)
          );
        }
      }

      const headers = ['recorded_at'];
      for (let m = 1; m <= maxModules; m++) {
        for (let c = 1; c <= maxCells; c++) {
          headers.push(`M${m}_C${c}`);
        }
      }

      // CSV headers & stream
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vehicle_${id}_cell_voltages.csv"`
      );

      // UTF-8 BOM (helps Excel open correctly with proper encoding)
      res.write('\uFEFF');

      res.write(headers.join(',') + '\n');

      for (const r of rows) {
        const row = new Array(headers.length).fill('');
        row[0] = CSV_SAFE_TIMESTAMP(r.recorded_at);

        r.cell_modules?.forEach((module, mi) => {
          module?.forEach((val, ci) => {
            const col = 1 + mi * maxCells + ci;
            row[col] = val ?? '';
          });
        });

        res.write(row.join(',') + '\n');
      }

      res.end();
    } catch (err) {
      logger.error(`Cell export failed (vehicle ${id}): ${err.message}`);
      res.status(500).json({ error: 'Export failed' });
    }
  }
);

/* -------------------------------------------------------
   TEMPERATURE SENSOR EXPORT
------------------------------------------------------- */
router.get(
  '/:id/export/temps',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const { id } = req.params;
    const isCustomer = req.user.role === 'customer';

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    try {
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

      if (!ownership.rows.length) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { timeClause, params } = await buildTimeFilter(req, id);

      const result = await db.query(
        `
        SELECT recorded_at, temp_modules
        FROM live_values
        WHERE vehicle_master_id = $1
          AND temp_modules IS NOT NULL
          AND ${timeClause}
        ORDER BY recorded_at ASC
        `,
        params
      );

      const rows = result.rows || [];

      let maxModules = 0;
      let maxSensors = 0;
      for (const r of rows) {
        if (Array.isArray(r.temp_modules)) {
          maxModules = Math.max(maxModules, r.temp_modules.length);
          r.temp_modules.forEach(m =>
            maxSensors = Math.max(maxSensors, Array.isArray(m) ? m.length : 0)
          );
        }
      }

      const headers = ['recorded_at'];
      for (let m = 1; m <= maxModules; m++) {
        for (let t = 1; t <= maxSensors; t++) {
          headers.push(`M${m}_T${t}`);
        }
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vehicle_${id}_temperature_sensors.csv"`
      );

      res.write('\uFEFF');

      res.write(headers.join(',') + '\n');

      for (const r of rows) {
        const row = new Array(headers.length).fill('');
        row[0] = CSV_SAFE_TIMESTAMP(r.recorded_at);

        r.temp_modules?.forEach((module, mi) => {
          module?.forEach((val, ti) => {
            const col = 1 + mi * maxSensors + ti;
            row[col] = val ?? '';
          });
        });

        res.write(row.join(',') + '\n');
      }

      res.end();
    } catch (err) {
      logger.error(`Temp export failed (vehicle ${id}): ${err.message}`);
      res.status(500).json({ error: 'Export failed' });
    }
  }
);

module.exports = router;