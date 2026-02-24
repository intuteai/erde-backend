// routes/database-logs.js - FULLY OPTIMIZED VERSION

const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

/* ============================================================
   SHARED HELPERS
   ============================================================ */

/**
 * Validate and parse the vehicle ID from request params.
 * Returns the numeric ID or null if invalid.
 */
function parseVehicleId(id) {
  const n = Number(id);
  return id && !isNaN(n) && n > 0 ? n : null;
}

/**
 * Build the WHERE time clause and append params.
 * Returns { timeClause, params } or throws { status, error }.
 */
function buildTimeClause(query, baseParams = []) {
  const { date, period, start, end } = query;
  const params = [...baseParams];

  if (!date && !period && !(start && end)) {
    throw { status: 400, error: 'Missing time range: provide date, period, or start/end' };
  }

  const nowIST = "timezone('Asia/Kolkata', now())";
  let timeClause = '';

  if (period) {
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
        throw { status: 400, error: 'Invalid period: use today, week, month, or all' };
    }
  } else if (start && end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw { status: 400, error: 'Invalid start/end date format (expected YYYY-MM-DD)' };
    }
    params.push(start, end);
    timeClause = `
      recorded_at >= timezone('Asia/Kolkata', $${params.length - 1}::date)
      AND recorded_at < timezone('Asia/Kolkata', $${params.length}::date + interval '1 day')
    `;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw { status: 400, error: 'Invalid date format (expected YYYY-MM-DD)' };
    }
    params.push(date);
    timeClause = `
      recorded_at >= timezone('Asia/Kolkata', $${params.length}::date)
      AND recorded_at < timezone('Asia/Kolkata', $${params.length}::date + interval '1 day')
    `;
  }

  return { timeClause, params };
}

/**
 * Confirm the requesting user has access to the vehicle.
 * Uses the shared pool (not a dedicated client).
 */
async function checkOwnership(vehicleId, user) {
  const isCustomer = user.role === 'customer';
  const result = await db.query(
    `SELECT 1
     FROM vehicle_master vm
     JOIN customer_master cm ON vm.customer_id = cm.customer_id
     WHERE vm.vehicle_master_id = $1
       AND ($2::int IS NULL OR cm.user_id = $2)`,
    [vehicleId, isCustomer ? user.user_id : null]
  );
  return result.rows.length > 0;
}

/**
 * Format a JS Date to IST locale string.
 */
function toIST(date) {
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/* ============================================================
   ALL COLUMN DEFINITIONS  (single source of truth)
   ============================================================ */

const ALL_COLUMN_DEFS = [
  { key: 'recorded_at',                 label: 'Timestamp',                      alwaysInclude: true },
  { key: 'soc_percent',                 label: 'SOC (%)' },
  { key: 'battery_status',              label: 'Battery Status' },
  { key: 'stack_voltage_v',             label: 'Stack Voltage (V)' },
  { key: 'battery_current_a',           label: 'Battery Current (A)' },
  { key: 'output_power_kw',             label: 'Output Power (kW)',              computed: true },
  { key: 'charger_current_demand_a',    label: 'Charger Current Demand (A)' },
  { key: 'charger_voltage_demand_v',    label: 'Charger Voltage Demand (V)' },
  { key: 'max_voltage_v',               label: 'Max Cell Voltage (V)' },
  { key: 'min_voltage_v',               label: 'Min Cell Voltage (V)' },
  { key: 'avg_voltage_v',               label: 'Avg Cell Voltage (V)' },
  { key: 'max_temp_c',                  label: 'Max Battery Temp (°C)' },
  { key: 'min_temp_c',                  label: 'Min Battery Temp (°C)' },
  { key: 'avg_temp_c',                  label: 'Avg Battery Temp (°C)' },
  { key: 'motor_torque_limit',          label: 'Motor Torque Limit (Nm)' },
  { key: 'motor_torque_value',          label: 'Motor Torque Value (Nm)' },
  { key: 'motor_speed_rpm',             label: 'Motor Speed (RPM)' },
  { key: 'motor_rotation_dir',          label: 'Motor Rotation Direction' },
  { key: 'motor_operation_mode',        label: 'Motor Operation Mode' },
  { key: 'mcu_enable_state',            label: 'MCU Enable State' },
  { key: 'motor_ac_current_a',          label: 'Motor AC Current (A)' },
  { key: 'motor_ac_voltage_v',          label: 'Motor AC Voltage (V)' },
  { key: 'dc_side_voltage_v',           label: 'DC Side Voltage (V)' },
  { key: 'motor_temp_c',                label: 'Motor Temperature (°C)' },
  { key: 'mcu_temp_c',                  label: 'MCU Temperature (°C)' },
  { key: 'radiator_temp_c',             label: 'Radiator Temperature (°C)' },
  { key: 'motor_status_word',           label: 'Motor Status Word' },
  { key: 'motor_freq_raw',              label: 'Motor Frequency Raw' },
  { key: 'motor_total_wattage_w',       label: 'Motor Total Wattage (W)' },
  { key: 'btms_command_mode',           label: 'BTMS Command Mode' },
  { key: 'btms_status_mode',            label: 'BTMS Status Mode' },
  { key: 'btms_hv_request',             label: 'BTMS HV Request' },
  { key: 'btms_charge_status',          label: 'BTMS Charge Status' },
  { key: 'bms_hv_relay_state',          label: 'BMS HV Relay State' },
  { key: 'btms_hv_relay_state',         label: 'BTMS HV Relay State' },
  { key: 'btms_target_temp_c',          label: 'BTMS Target Temp (°C)' },
  { key: 'btms_inlet_temp_c',           label: 'BTMS Inlet Temp (°C)' },
  { key: 'btms_outlet_temp_c',          label: 'BTMS Outlet Temp (°C)' },
  { key: 'btms_demand_power_kw',        label: 'BTMS Demand Power (kW)' },
  { key: 'bms_pack_voltage_v',          label: 'BMS Pack Voltage (V)' },
  { key: 'bms_life_counter',            label: 'BMS Life Counter' },
  { key: 'btms_command_crc',            label: 'BTMS Command CRC' },
  { key: 'dcdc_pri_a_mosfet_temp_c',   label: 'DCDC Pri A MOSFET Temp (°C)' },
  { key: 'dcdc_sec_ls_mosfet_temp_c',  label: 'DCDC Sec LS MOSFET Temp (°C)' },
  { key: 'dcdc_sec_hs_mosfet_temp_c',  label: 'DCDC Sec HS MOSFET Temp (°C)' },
  { key: 'dcdc_pri_c_mosfet_temp_c',   label: 'DCDC Pri C MOSFET Temp (°C)' },
  { key: 'dcdc_max_temp_c',            label: 'DCDC Max Temp (°C)' },
  { key: 'dcdc_input_voltage_v',       label: 'DCDC Input Voltage (V)' },
  { key: 'dcdc_input_current_a',       label: 'DCDC Input Current (A)' },
  { key: 'dcdc_output_voltage_v',      label: 'DCDC Output Voltage (V)' },
  { key: 'dcdc_output_current_a',      label: 'DCDC Output Current (A)' },
  { key: 'dcdc_occurence_count',       label: 'DCDC Overcurrent Count' },
  { key: 'compressor_input_voltage_v', label: 'Compressor Input Voltage (V)' },
  { key: 'compressor_input_current_a', label: 'Compressor Input Current (A)' },
  { key: 'compressor_output_voltage_v',label: 'Compressor Output Voltage (V)' },
  { key: 'compressor_output_current_a',label: 'Compressor Output Current (A)' },
  { key: 'total_running_hrs',          label: 'Total Running Hours',            interval: true },
  { key: 'last_trip_hrs',              label: 'Last Trip Hours',                interval: true },
  { key: 'total_kwh_consumed',         label: 'Total kWh Consumed' },
  { key: 'last_trip_kwh',              label: 'Last Trip kWh' },
];

const ALL_COLUMN_MAP = Object.fromEntries(ALL_COLUMN_DEFS.map(c => [c.key, c]));

/**
 * Build a SQL SELECT expression for a column key.
 */
function colToSQL(key) {
  const def = ALL_COLUMN_MAP[key];
  if (!def) return key;
  if (def.interval)  return `to_char(${key}, 'HH24:MI:SS') AS ${key}`;
  if (def.computed && key === 'output_power_kw')
    return `ROUND(CAST((stack_voltage_v * ABS(battery_current_a)) / 1000.0 AS numeric), 3) AS output_power_kw`;
  return key;
}

/**
 * Parse and validate the ?columns= query param.
 * Returns an array of valid column keys, or ALL_COLUMN_DEFS keys if omitted.
 */
function parseColumns(columnsParam) {
  if (!columnsParam) return ALL_COLUMN_DEFS.map(c => c.key);

  let requested;
  try {
    requested = JSON.parse(columnsParam);
  } catch {
    throw { status: 400, error: 'Invalid columns format – expected a JSON array' };
  }

  if (!Array.isArray(requested)) {
    throw { status: 400, error: 'columns must be a JSON array' };
  }

  // Whitelist: only keep keys that exist in our definition list
  const valid = requested.filter(k => ALL_COLUMN_MAP[k]);
  if (valid.length === 0) {
    throw { status: 400, error: 'No valid columns specified' };
  }
  return valid;
}

/* ============================================================
   GET /api/database-logs/:id
   Cursor-paginated rows for the frontend table (200 rows/page).
   ============================================================ */
router.get(
  '/:id',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const vehicleId = parseVehicleId(req.params.id);
    if (!vehicleId) return res.status(400).json([]);

    let timeInfo;
    try {
      timeInfo = buildTimeClause(req.query, [vehicleId]);
    } catch (e) {
      return res.status(e.status).json({ error: e.error });
    }

    const { timeClause, params } = timeInfo;
    const { cursor } = req.query;

    try {
      const allowed = await checkOwnership(vehicleId, req.user);
      if (!allowed) {
        logger.warn(`Access denied: user ${req.user.email} for vehicle ${vehicleId}`);
        return res.status(403).json([]);
      }

      // Build the SELECT list from ALL columns (the table always shows everything)
      const selectFields = ALL_COLUMN_DEFS.map(c => colToSQL(c.key)).join(',\n          ');

      let cursorClause = '';
      const queryParams = [...params];
      if (cursor) {
        queryParams.push(cursor);
        cursorClause = `AND recorded_at > $${queryParams.length}::timestamptz`;
      }

      const sql = `
        SELECT
          ${selectFields}
        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${timeClause}
          ${cursorClause}
        ORDER BY recorded_at ASC
        LIMIT 200
      `;

      const result = await db.query(sql, queryParams);
      const rows = result.rows ?? [];

      const formatted = rows.map(row => ({
        ...row,
        recorded_at_raw: row.recorded_at.toISOString(),
        recorded_at: toIST(row.recorded_at),
      }));

      res.set('X-Has-More', rows.length === 200 ? 'true' : 'false');
      return res.status(200).json(formatted);

    } catch (err) {
      logger.error(`Database logs error (vehicle ${vehicleId}): ${err.message}`);
      return res.status(500).json([]);
    }
  }
);

/* ============================================================
   GET /api/database-logs/:id/count
   Returns the total row count for a given time range.
   ============================================================ */
router.get(
  '/:id/count',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const vehicleId = parseVehicleId(req.params.id);
    if (!vehicleId) return res.status(400).json({ error: 'Invalid vehicle ID' });

    let timeInfo;
    try {
      timeInfo = buildTimeClause(req.query, [vehicleId]);
    } catch (e) {
      return res.status(e.status).json({ error: e.error });
    }

    const { timeClause, params } = timeInfo;

    try {
      const allowed = await checkOwnership(vehicleId, req.user);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });

      const result = await db.query(
        `SELECT COUNT(*) AS total
         FROM live_values
         WHERE vehicle_master_id = $1
           AND ${timeClause}`,
        params
      );

      return res.status(200).json({ total: parseInt(result.rows[0].total, 10) });

    } catch (err) {
      logger.error(`Count error (vehicle ${vehicleId}): ${err.message}`);
      return res.status(500).json({ error: 'Failed to get count' });
    }
  }
);

/* ============================================================
   GET /api/database-logs/:id/export
   Streaming CSV export – handles millions of rows.

   Key optimisations vs original:
   1. Single aggregated query to detect empty columns (was N parallel queries).
   2. Statement timeout prevents indefinite hangs.
   3. Dedicated pg client kept only for the cursor lifespan; released in finally.
   4. Ownership + count reuse the shared pool so the dedicated client is
      acquired as late as possible.
   ============================================================ */
router.get(
  '/:id/export',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const vehicleId = parseVehicleId(req.params.id);
    if (!vehicleId) return res.status(400).json({ error: 'Invalid vehicle ID' });

    // ---- parse columns ----
    let columnKeys;
    try {
      columnKeys = parseColumns(req.query.columns);
    } catch (e) {
      return res.status(e.status).json({ error: e.error });
    }

    // ---- build time clause ----
    let timeInfo;
    try {
      timeInfo = buildTimeClause(req.query, [vehicleId]);
    } catch (e) {
      return res.status(e.status).json({ error: e.error });
    }

    const { timeClause, params } = timeInfo;

    // ---- ownership check (shared pool) ----
    try {
      const allowed = await checkOwnership(vehicleId, req.user);
      if (!allowed) {
        logger.warn(`Export access denied: user ${req.user.email} for vehicle ${vehicleId}`);
        return res.status(403).json({ error: 'Access denied' });
      }
    } catch (err) {
      logger.error(`Ownership check error: ${err.message}`);
      return res.status(500).json({ error: 'Internal error' });
    }

    // ---- get total row count (shared pool) ----
    let totalRows = 0;
    try {
      const countResult = await db.query(
        `SELECT COUNT(*) AS total
         FROM live_values
         WHERE vehicle_master_id = $1
           AND ${timeClause}`,
        params
      );
      totalRows = parseInt(countResult.rows[0].total, 10);
    } catch (err) {
      logger.error(`Export count error (vehicle ${vehicleId}): ${err.message}`);
      return res.status(500).json({ error: 'Failed to get row count' });
    }

    if (totalRows === 0) {
      return res.status(400).json({ error: 'No data available for the selected range' });
    }

    logger.info(`Export starting – vehicle ${vehicleId}: ${totalRows} rows, ${columnKeys.length} requested columns`);

    // ---- acquire dedicated client for cursor streaming ----
    let client;
    try {
      client = await db.getClient();

      // Hard timeout: never let an export hang indefinitely
      await client.query("SET statement_timeout = '180s'");

      /* ----------------------------------------------------------
         STEP 1 – detect empty columns with ONE aggregated query
         (replaces the original N parallel queries)
         ---------------------------------------------------------- */
      const regularKeys  = columnKeys.filter(k => k !== 'recorded_at' && k !== 'output_power_kw');
      const hasComputed  = columnKeys.includes('output_power_kw');

      // Build COUNT(col) expressions for all plain columns in one shot
      const countExprs = regularKeys
        .map(k => `COUNT(${k}) AS ${k}`)
        .join(',\n          ');

      // output_power_kw is valid when both source columns are non-null
      const computedExpr = hasComputed
        ? `, COUNT(CASE WHEN stack_voltage_v IS NOT NULL AND battery_current_a IS NOT NULL THEN 1 END) AS output_power_kw`
        : '';

      const emptyCheckSQL = `
        SELECT
          ${countExprs || '1 AS _dummy'}
          ${computedExpr}
        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${timeClause}
      `;

      const checkResult = await client.query(emptyCheckSQL, params);
      const counts = checkResult.rows[0];

      // Decide which columns actually have data
      const activeColumnKeys = columnKeys.filter(key => {
        if (key === 'recorded_at') return true;          // always present
        return parseInt(counts[key] ?? '0', 10) > 0;
      });

      const activeColumnLabels = activeColumnKeys.map(k => ALL_COLUMN_MAP[k]?.label ?? k);

      if (activeColumnKeys.length === 0) {
        client.release();
        client = null;
        return res.status(400).json({ error: 'No data available in selected columns' });
      }

      const skipped = columnKeys.length - activeColumnKeys.length;
      if (skipped > 0) {
        logger.info(`Skipped ${skipped} empty columns. Exporting ${activeColumnKeys.length} columns.`);
      }

      /* ----------------------------------------------------------
         STEP 2 – build SELECT for the export query
         ---------------------------------------------------------- */
      const selectFields = activeColumnKeys.map(k => colToSQL(k)).join(',\n          ');

      const exportSQL = `
        SELECT
          ${selectFields}
        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${timeClause}
        ORDER BY recorded_at ASC
      `;

      /* ----------------------------------------------------------
         STEP 3 – stream CSV via server-side cursor
         ---------------------------------------------------------- */
      const { period, date, start, end } = req.query;
      const rangeTag = period || date || `${start}_to_${end}`;
      const filename = `telemetry_${vehicleId}_${rangeTag}_${Date.now()}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Total-Rows', totalRows.toString());

      // CSV header row
      const csvHeader = activeColumnLabels.map(l => `"${l}"`).join(',') + '\n';
      res.write(csvHeader);

      const CHUNK_SIZE = 5000;
      const cursorName = `export_cursor_${Date.now()}_${vehicleId}`;
      let rowCount = 0;
      let chunkCount = 0;

      await client.query('BEGIN');
      await client.query(`DECLARE ${cursorName} CURSOR FOR ${exportSQL}`, params);

      while (true) {
        const { rows } = await client.query(`FETCH ${CHUNK_SIZE} FROM ${cursorName}`);
        if (rows.length === 0) break;

        chunkCount++;
        rowCount += rows.length;

        const csvChunk = rows.map(row =>
          activeColumnKeys.map(key => {
            let val = row[key];

            // Format timestamp to IST
            if (key === 'recorded_at' && val instanceof Date) {
              val = toIST(val);
            }

            if (val === null || val === undefined) return '';

            // Escape double-quotes and wrap in quotes
            return `"${String(val).replace(/"/g, '""')}"`;
          }).join(',')
        ).join('\n') + '\n';

        res.write(csvChunk);

        // Log progress every 50k rows
        if (chunkCount % 10 === 0) {
          logger.info(`Export progress – vehicle ${vehicleId}: ${rowCount}/${totalRows} rows (${((rowCount / totalRows) * 100).toFixed(1)}%)`);
        }
      }

      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');

      logger.info(`Export complete – vehicle ${vehicleId}: ${rowCount} rows, ${activeColumnKeys.length} columns`);
      res.end();

    } catch (err) {
      logger.error(`Export error (vehicle ${vehicleId}): ${err.message}`);

      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      }

      if (!res.headersSent) {
        return res.status(500).json({ error: 'Export failed' });
      }
      res.end();

    } finally {
      if (client) client.release();
    }
  }
);

module.exports = router;