const express = require('express');
const zlib    = require('zlib');
const db      = require('../config/postgres');
const redis   = require('../config/redis');
const authenticateToken = require('../middleware/auth');
const checkPermission   = require('../middleware/checkPermission');
const { generalLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

// Backpressure-safe gzip helpers — pause the cursor loop when the
// client is slow so Node's write buffer never grows unbounded.
function gzipWrite(gz, data) {
  return new Promise((resolve, reject) => {
    const ok = gz.write(data);
    if (ok) return resolve();
    gz.once('drain', resolve);
    gz.once('error', reject);
  });
}

function gzipEnd(gz) {
  return new Promise((resolve, reject) => {
    gz.once('finish', resolve);
    gz.once('error', reject);
    gz.end();
  });
}

/* -------------------------------------------------------
   3-tier structure lookup
   1. Redis   — sub-millisecond, warm after first telemetry batch
   2. vehicle_master columns — already fetched in ownership row
   3. 20-row scan — cold-start fallback for brand-new vehicles
------------------------------------------------------- */
async function getVehicleStructure(vehicleId, ownershipRow, db, timeClause, params) {
  // Tier 1: Redis
  try {
    const cached = await redis.get(`vehicle_structure:${vehicleId}`);
    if (cached) {
      const d = JSON.parse(cached);
      if (d.cellMods > 0 || d.tempMods > 0) return d;
    }
  } catch { /* Redis failure is non-critical */ }

  // Tier 2: vehicle_master columns (already in ownership query result)
  const row = ownershipRow;
  const fromDB = {
    cellMods:      row.max_cell_modules       || 0,
    cellsPerMod:   row.max_cells_per_module   || 0,
    tempMods:      row.max_temp_modules       || 0,
    sensorsPerMod: row.max_sensors_per_module || 0,
  };
  if (fromDB.cellMods > 0 || fromDB.tempMods > 0) {
    redis.set(`vehicle_structure:${vehicleId}`, JSON.stringify(fromDB), { EX: 86400 })
         .catch(() => {});
    return fromDB;
  }

  // Tier 3: cold-start scan — only runs for brand-new vehicles
  logger.info(`Cold-start structure scan for vehicle ${vehicleId}`);
  const sample = await db.query(
    `(SELECT cell_modules, temp_modules FROM live_values
      WHERE vehicle_master_id = $1 AND (cell_modules IS NOT NULL OR temp_modules IS NOT NULL)
        AND ${timeClause}
      ORDER BY recorded_at DESC LIMIT 20)`,
    params
  );
  let cellMods = 0, cellsPerMod = 0, tempMods = 0, sensorsPerMod = 0;
  for (const r of sample.rows) {
    if (Array.isArray(r.cell_modules)) {
      cellMods = Math.max(cellMods, r.cell_modules.length);
      for (const m of r.cell_modules) {
        if (Array.isArray(m)) cellsPerMod = Math.max(cellsPerMod, m.length);
      }
    }
    if (Array.isArray(r.temp_modules)) {
      tempMods = Math.max(tempMods, r.temp_modules.length);
      for (const m of r.temp_modules) {
        if (Array.isArray(m)) sensorsPerMod = Math.max(sensorsPerMod, m.length);
      }
    }
  }
  return { cellMods, cellsPerMod, tempMods, sensorsPerMod };
}

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
   IST timestamp — matches toIST() in database-logs.js
   Tab prefix forces Excel to treat cell as plain text,
   preserving seconds and AM/PM without auto-reformatting.
------------------------------------------------------- */
function toIST(date) {
  const ist = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const yyyy = ist.getFullYear();
  const mm   = String(ist.getMonth() + 1).padStart(2, '0');
  const dd   = String(ist.getDate()).padStart(2, '0');
  let   hh   = ist.getHours();
  const min  = String(ist.getMinutes()).padStart(2, '0');
  const ss   = String(ist.getSeconds()).padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  return `${dd}-${mm}-${yyyy} ${String(hh).padStart(2, '0')}:${min}:${ss} ${ampm}`;
}

// Tab-prefixed so Excel treats it as plain text
const CSV_SAFE_TIMESTAMP = (ts) => `"\t${toIST(ts)}"`;

/* -------------------------------------------------------
   GET ROW COUNT (kept for backward compatibility)
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
      const ownership = await db.query(
        `SELECT 1
         FROM vehicle_master vm
         JOIN customer_master cm ON vm.customer_id = cm.customer_id
         WHERE vm.vehicle_master_id = $1
           AND ($2::int IS NULL OR cm.user_id = $2)`,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (!ownership.rows.length) {
        logger.warn(`Access denied: user ${req.user.email || 'unknown'} tried ${type} export for vehicle ${id}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const { timeClause, params } = await buildTimeFilter(req, id);
      const column = type === 'cells' ? 'cell_modules' : 'temp_modules';

      const result = await db.query(
        `SELECT COUNT(*) as total FROM live_values
         WHERE vehicle_master_id = $1 AND ${column} IS NOT NULL AND ${timeClause}`,
        params
      );

      return res.status(200).json({ total: parseInt(result.rows[0].total, 10) });

    } catch (err) {
      logger.error(`Count error (vehicle ${id}, type ${type}): ${err.message}`);
      return res.status(500).json({ error: err.message || 'Failed to get count' });
    }
  }
);

/* -------------------------------------------------------
   CELL VOLTAGE EXPORT
   - Count + structure resolved in parallel
   - statement_timeout on cursor client
   - Gzip compressed with backpressure
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
    let gz;

    try {
      const ownership = await db.query(
        `SELECT vm.max_cell_modules, vm.max_cells_per_module,
                vm.max_temp_modules, vm.max_sensors_per_module
         FROM vehicle_master vm
         JOIN customer_master cm ON vm.customer_id = cm.customer_id
         WHERE vm.vehicle_master_id = $1
           AND ($2::int IS NULL OR cm.user_id = $2)`,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (!ownership.rows.length) {
        logger.warn(`Cell export access denied: user ${req.user.email || 'unknown'} for vehicle ${id}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const { timeClause, params } = await buildTimeFilter(req, id);

      // Count and structure lookup run in parallel
      const [countResult, structure] = await Promise.all([
        db.query(
          `SELECT COUNT(*) as total FROM live_values
           WHERE vehicle_master_id = $1 AND cell_modules IS NOT NULL AND ${timeClause}`,
          params
        ),
        getVehicleStructure(id, ownership.rows[0], db, timeClause, params),
      ]);

      const totalRows = parseInt(countResult.rows[0].total, 10);

      if (totalRows === 0) {
        logger.info(`No cell voltage data for vehicle ${id}`);
        return res.status(400).json({ error: 'No cell voltage data for the selected range' });
      }

      const maxModules = structure.cellMods;
      const maxCells   = structure.cellsPerMod;

      logger.info(`Cell voltage export: vehicle ${id}, ${totalRows} rows, ${maxModules}x${maxCells} structure`);

      client = await db.getClient();
      await client.query("SET statement_timeout = '180s'");

      const cursorName = `cells_cursor_${Date.now()}`;
      await client.query('BEGIN');
      await client.query(
        `DECLARE ${cursorName} CURSOR FOR
         SELECT recorded_at, cell_modules FROM live_values
         WHERE vehicle_master_id = $1 AND cell_modules IS NOT NULL AND ${timeClause}
         ORDER BY recorded_at ASC`,
        params
      );

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Disposition', `attachment; filename="vehicle_${id}_cell_voltages_${Date.now()}.csv"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Total-Rows', totalRows.toString());

      gz = zlib.createGzip({ level: 6 });
      gz.pipe(res);

      // UTF-8 BOM + CSV header
      const headers = ['Timestamp'];
      for (let m = 1; m <= maxModules; m++) {
        for (let c = 1; c <= maxCells; c++) headers.push(`M${m}_C${c}`);
      }
      await gzipWrite(gz, '﻿' + headers.join(',') + '\n');

      const CHUNK_SIZE = 1000;
      let rowCount = 0;
      let chunkCount = 0;

      while (true) {
        const { rows } = await client.query(`FETCH ${CHUNK_SIZE} FROM ${cursorName}`);
        if (rows.length === 0) break;

        chunkCount++;
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

        await gzipWrite(gz, csvChunk);
        rowCount += rows.length;

        if (chunkCount % 10 === 0) {
          logger.info(`Cell export: ${rowCount}/${totalRows} rows (${((rowCount / totalRows) * 100).toFixed(1)}%) vehicle ${id}`);
        }
      }

      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');
      logger.info(`Cell voltage export complete: ${rowCount} rows for vehicle ${id}`);
      await gzipEnd(gz);

    } catch (err) {
      logger.error(`Cell export failed (vehicle ${id}): ${err.message}`);
      if (client) {
        try { await client.query('ROLLBACK'); } catch (e) { logger.error(`Rollback error: ${e.message}`); }
      }
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Export failed' });
      }
      if (gz) gz.destroy();
    } finally {
      if (client) client.release();
    }
  }
);

/* -------------------------------------------------------
   TEMPERATURE SENSOR EXPORT
   - Count + structure resolved in parallel
   - statement_timeout on cursor client
   - Gzip compressed with backpressure
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
    let gz;

    try {
      const ownership = await db.query(
        `SELECT vm.max_cell_modules, vm.max_cells_per_module,
                vm.max_temp_modules, vm.max_sensors_per_module
         FROM vehicle_master vm
         JOIN customer_master cm ON vm.customer_id = cm.customer_id
         WHERE vm.vehicle_master_id = $1
           AND ($2::int IS NULL OR cm.user_id = $2)`,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (!ownership.rows.length) {
        logger.warn(`Temperature export access denied: user ${req.user.email || 'unknown'} for vehicle ${id}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      const { timeClause, params } = await buildTimeFilter(req, id);

      // Count and structure lookup run in parallel
      const [countResult, structure] = await Promise.all([
        db.query(
          `SELECT COUNT(*) as total FROM live_values
           WHERE vehicle_master_id = $1 AND temp_modules IS NOT NULL AND ${timeClause}`,
          params
        ),
        getVehicleStructure(id, ownership.rows[0], db, timeClause, params),
      ]);

      const totalRows = parseInt(countResult.rows[0].total, 10);

      if (totalRows === 0) {
        logger.info(`No temperature data for vehicle ${id}`);
        return res.status(400).json({ error: 'No temperature data for the selected range' });
      }

      const maxModules = structure.tempMods;
      const maxSensors = structure.sensorsPerMod;

      logger.info(`Temperature export: vehicle ${id}, ${totalRows} rows, ${maxModules}x${maxSensors} structure`);

      client = await db.getClient();
      await client.query("SET statement_timeout = '180s'");

      const cursorName = `temps_cursor_${Date.now()}`;
      await client.query('BEGIN');
      await client.query(
        `DECLARE ${cursorName} CURSOR FOR
         SELECT recorded_at, temp_modules FROM live_values
         WHERE vehicle_master_id = $1 AND temp_modules IS NOT NULL AND ${timeClause}
         ORDER BY recorded_at ASC`,
        params
      );

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Disposition', `attachment; filename="vehicle_${id}_temperature_sensors_${Date.now()}.csv"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Total-Rows', totalRows.toString());

      gz = zlib.createGzip({ level: 6 });
      gz.pipe(res);

      // UTF-8 BOM + CSV header
      const headers = ['Timestamp'];
      for (let m = 1; m <= maxModules; m++) {
        for (let t = 1; t <= maxSensors; t++) headers.push(`M${m}_T${t}`);
      }
      await gzipWrite(gz, '﻿' + headers.join(',') + '\n');

      const CHUNK_SIZE = 1000;
      let rowCount = 0;
      let chunkCount = 0;

      while (true) {
        const { rows } = await client.query(`FETCH ${CHUNK_SIZE} FROM ${cursorName}`);
        if (rows.length === 0) break;

        chunkCount++;
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

        await gzipWrite(gz, csvChunk);
        rowCount += rows.length;

        if (chunkCount % 10 === 0) {
          logger.info(`Temp export: ${rowCount}/${totalRows} rows (${((rowCount / totalRows) * 100).toFixed(1)}%) vehicle ${id}`);
        }
      }

      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');
      logger.info(`Temperature export complete: ${rowCount} rows for vehicle ${id}`);
      await gzipEnd(gz);

    } catch (err) {
      logger.error(`Temp export failed (vehicle ${id}): ${err.message}`);
      if (client) {
        try { await client.query('ROLLBACK'); } catch (e) { logger.error(`Rollback error: ${e.message}`); }
      }
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Export failed' });
      }
      if (gz) gz.destroy();
    } finally {
      if (client) client.release();
    }
  }
);

module.exports = router;
