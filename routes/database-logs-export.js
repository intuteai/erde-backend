const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

/* -------------------------------------------------------
   Shared helper: ownership + time filter
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
      default:
        throw new Error('Invalid period. Use "today" only.');
    }
  } else if (start && end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD');
    }
    params.push(start, end);
    timeClause = `
      recorded_at >= timezone('Asia/Kolkata', $2::date)
      AND recorded_at < timezone('Asia/Kolkata', $3::date + interval '1 day')
    `;
  } else {
    throw new Error('Missing time range. Provide "period=today" or "start" and "end" dates.');
  }

  return { timeClause, params };
}

/* -------------------------------------------------------
   CSV-safe IST timestamp formatting
------------------------------------------------------- */
function formatRecordedAtForCSV(ts) {
  return ts.toLocaleString('sv-SE', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
  }).replace('T', ' ');
}

const CSV_SAFE_TIMESTAMP = (ts) => `"${formatRecordedAtForCSV(ts)}"`;

/* -------------------------------------------------------
   GET ROW COUNT (for progress tracking)
------------------------------------------------------- */
router.get(
  '/:id/export/:type/count',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const { id, type } = req.params;
    const isCustomer = req.user.role === 'customer';

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    if (!['cells', 'temps'].includes(type)) {
      return res.status(400).json({ error: 'Invalid export type. Use "cells" or "temps".' });
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
        logger.warn(`Access denied: user ${req.user.email || 'unknown'} tried ${type} export for vehicle ${id}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const { timeClause, params } = await buildTimeFilter(req, id);

      const column = type === 'cells' ? 'cell_modules' : 'temp_modules';
      
      const countQuery = `
        SELECT COUNT(*) as total
        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${column} IS NOT NULL
          AND ${timeClause}
      `;

      const result = await db.query(countQuery, params);
      const total = parseInt(result.rows[0].total, 10);

      return res.status(200).json({ total });

    } catch (err) {
      logger.error(`Count error (vehicle ${id}, type ${type}): ${err.message}`);
      return res.status(500).json({ error: err.message || 'Failed to get count' });
    }
  }
);

/* -------------------------------------------------------
   CELL VOLTAGE EXPORT - STREAMING WITH PROGRESS
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

    let client;

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
        logger.warn(`Cell export access denied: user ${req.user.email || 'unknown'} for vehicle ${id}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const { timeClause, params } = await buildTimeFilter(req, id);

      // Get total count for progress
      const countResult = await db.query(
        `
        SELECT COUNT(*) as total
        FROM live_values
        WHERE vehicle_master_id = $1
          AND cell_modules IS NOT NULL
          AND ${timeClause}
        `,
        params
      );

      const totalRows = parseInt(countResult.rows[0].total, 10);

      if (totalRows === 0) {
        logger.info(`No cell voltage data for vehicle ${id}`);
        return res.status(200).send('No data available');
      }

      logger.info(`Starting cell voltage export for vehicle ${id}: ${totalRows} total rows`);

      // Get dedicated client for cursor
      client = await db.getClient();

      const query = `
        SELECT recorded_at, cell_modules
        FROM live_values
        WHERE vehicle_master_id = $1
          AND cell_modules IS NOT NULL
          AND ${timeClause}
        ORDER BY recorded_at ASC
      `;

      // Start transaction and create cursor
      const cursorName = `cells_cursor_${Date.now()}`;
      await client.query('BEGIN');
      await client.query(`DECLARE ${cursorName} CURSOR FOR ${query}`, params);

      // Set response headers
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vehicle_${id}_cell_voltages_${Date.now()}.csv"`
      );
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Total-Rows', totalRows.toString());

      // UTF-8 BOM for Excel compatibility
      res.write('\uFEFF');

      // First pass: determine max structure
      const CHUNK_SIZE = 1000;
      let maxModules = 0;
      let maxCells = 0;
      let rowCount = 0;

      // Scan first chunk to determine structure
      const structureSample = await client.query(`FETCH 100 FROM ${cursorName}`);
      for (const r of structureSample.rows) {
        if (Array.isArray(r.cell_modules)) {
          maxModules = Math.max(maxModules, r.cell_modules.length);
          r.cell_modules.forEach(m =>
            maxCells = Math.max(maxCells, Array.isArray(m) ? m.length : 0)
          );
        }
      }

      // Build headers
      const headers = ['recorded_at'];
      for (let m = 1; m <= maxModules; m++) {
        for (let c = 1; c <= maxCells; c++) {
          headers.push(`M${m}_C${c}`);
        }
      }

      // Write CSV header
      res.write(headers.join(',') + '\n');

      // Write sample rows
      for (const r of structureSample.rows) {
        const row = new Array(headers.length).fill('');
        row[0] = CSV_SAFE_TIMESTAMP(r.recorded_at);

        r.cell_modules?.forEach((module, mi) => {
          module?.forEach((val, ci) => {
            const col = 1 + mi * maxCells + ci;
            if (col < row.length) row[col] = val ?? '';
          });
        });

        res.write(row.join(',') + '\n');
        rowCount++;
      }

      // Continue with remaining data in chunks
      let chunkCount = 1;
      while (true) {
        const { rows } = await client.query(`FETCH ${CHUNK_SIZE} FROM ${cursorName}`);
        
        if (rows.length === 0) break;

        chunkCount++;

        // Convert rows to CSV
        const csvChunk = rows.map(r => {
          const row = new Array(headers.length).fill('');
          row[0] = CSV_SAFE_TIMESTAMP(r.recorded_at);

          r.cell_modules?.forEach((module, mi) => {
            module?.forEach((val, ci) => {
              const col = 1 + mi * maxCells + ci;
              if (col < row.length) row[col] = val ?? '';
            });
          });

          return row.join(',');
        }).join('\n') + '\n';

        res.write(csvChunk);
        rowCount += rows.length;

        // Log progress every 10 chunks (10k rows)
        if (chunkCount % 10 === 0) {
          const percentComplete = ((rowCount / totalRows) * 100).toFixed(1);
          logger.info(`Cell export progress: ${rowCount}/${totalRows} rows (${percentComplete}%) for vehicle ${id}`);
        }
      }

      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');

      logger.info(`Cell voltage export completed: ${rowCount} rows for vehicle ${id}`);
      res.end();

    } catch (err) {
      logger.error(`Cell export failed (vehicle ${id}): ${err.message}`);
      
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          logger.error(`Rollback error: ${rollbackErr.message}`);
        }
      }

      if (!res.headersSent) {
        return res.status(500).json({ error: 'Export failed' });
      } else {
        res.end();
      }
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

/* -------------------------------------------------------
   TEMPERATURE SENSOR EXPORT - STREAMING WITH PROGRESS
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

    let client;

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
        logger.warn(`Temperature export access denied: user ${req.user.email || 'unknown'} for vehicle ${id}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const { timeClause, params } = await buildTimeFilter(req, id);

      // Get total count for progress
      const countResult = await db.query(
        `
        SELECT COUNT(*) as total
        FROM live_values
        WHERE vehicle_master_id = $1
          AND temp_modules IS NOT NULL
          AND ${timeClause}
        `,
        params
      );

      const totalRows = parseInt(countResult.rows[0].total, 10);

      if (totalRows === 0) {
        logger.info(`No temperature data for vehicle ${id}`);
        return res.status(200).send('No data available');
      }

      logger.info(`Starting temperature export for vehicle ${id}: ${totalRows} total rows`);

      // Get dedicated client for cursor
      client = await db.getClient();

      const query = `
        SELECT recorded_at, temp_modules
        FROM live_values
        WHERE vehicle_master_id = $1
          AND temp_modules IS NOT NULL
          AND ${timeClause}
        ORDER BY recorded_at ASC
      `;

      // Start transaction and create cursor
      const cursorName = `temps_cursor_${Date.now()}`;
      await client.query('BEGIN');
      await client.query(`DECLARE ${cursorName} CURSOR FOR ${query}`, params);

      // Set response headers
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vehicle_${id}_temperature_sensors_${Date.now()}.csv"`
      );
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Total-Rows', totalRows.toString());

      // UTF-8 BOM for Excel compatibility
      res.write('\uFEFF');

      // First pass: determine max structure
      const CHUNK_SIZE = 1000;
      let maxModules = 0;
      let maxSensors = 0;
      let rowCount = 0;

      // Scan first chunk to determine structure
      const structureSample = await client.query(`FETCH 100 FROM ${cursorName}`);
      for (const r of structureSample.rows) {
        if (Array.isArray(r.temp_modules)) {
          maxModules = Math.max(maxModules, r.temp_modules.length);
          r.temp_modules.forEach(m =>
            maxSensors = Math.max(maxSensors, Array.isArray(m) ? m.length : 0)
          );
        }
      }

      // Build headers
      const headers = ['recorded_at'];
      for (let m = 1; m <= maxModules; m++) {
        for (let t = 1; t <= maxSensors; t++) {
          headers.push(`M${m}_T${t}`);
        }
      }

      // Write CSV header
      res.write(headers.join(',') + '\n');

      // Write sample rows
      for (const r of structureSample.rows) {
        const row = new Array(headers.length).fill('');
        row[0] = CSV_SAFE_TIMESTAMP(r.recorded_at);

        r.temp_modules?.forEach((module, mi) => {
          module?.forEach((val, ti) => {
            const col = 1 + mi * maxSensors + ti;
            if (col < row.length) row[col] = val ?? '';
          });
        });

        res.write(row.join(',') + '\n');
        rowCount++;
      }

      // Continue with remaining data in chunks
      let chunkCount = 1;
      while (true) {
        const { rows } = await client.query(`FETCH ${CHUNK_SIZE} FROM ${cursorName}`);
        
        if (rows.length === 0) break;

        chunkCount++;

        // Convert rows to CSV
        const csvChunk = rows.map(r => {
          const row = new Array(headers.length).fill('');
          row[0] = CSV_SAFE_TIMESTAMP(r.recorded_at);

          r.temp_modules?.forEach((module, mi) => {
            module?.forEach((val, ti) => {
              const col = 1 + mi * maxSensors + ti;
              if (col < row.length) row[col] = val ?? '';
            });
          });

          return row.join(',');
        }).join('\n') + '\n';

        res.write(csvChunk);
        rowCount += rows.length;

        // Log progress every 10 chunks (10k rows)
        if (chunkCount % 10 === 0) {
          const percentComplete = ((rowCount / totalRows) * 100).toFixed(1);
          logger.info(`Temp export progress: ${rowCount}/${totalRows} rows (${percentComplete}%) for vehicle ${id}`);
        }
      }

      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');

      logger.info(`Temperature export completed: ${rowCount} rows for vehicle ${id}`);
      res.end();

    } catch (err) {
      logger.error(`Temp export failed (vehicle ${id}): ${err.message}`);
      
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          logger.error(`Rollback error: ${rollbackErr.message}`);
        }
      }

      if (!res.headersSent) {
        return res.status(500).json({ error: 'Export failed' });
      } else {
        res.end();
      }
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

module.exports = router;