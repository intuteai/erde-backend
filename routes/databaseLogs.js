// routes/database-logs.js - OPTIMIZED VERSION

const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const router = express.Router();

/**
 * GET /api/database-logs/:id
 * Paginated view for frontend table display
 */
router.get(
  '/:id',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const { id } = req.params;
    let { date, period, start, end, cursor } = req.query;
    const isCustomer = req.user.role === 'customer';

    // ---------------- VALIDATION ----------------
    if (!id || isNaN(Number(id))) {
      return res.status(400).json([]);
    }

    if (!date && !period && !(start && end)) {
      return res.status(400).json({ error: 'Missing time range: provide date, period, or start/end' });
    }

    try {
      // ---------------- OWNERSHIP CHECK ----------------
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

      if (ownership.rows.length === 0) {
        logger.warn(`Access denied: user ${req.user.email || 'unknown'} tried logs for vehicle ${id}`);
        return res.status(403).json([]);
      }

      // ---------------- BUILD TIME FILTER ----------------
      let timeClause = '';
      const params = [Number(id)];

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
            return res.status(400).json({ error: 'Invalid period: use today, week, month, or all' });
        }
      } else if (start && end) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
          return res.status(400).json({ error: 'Invalid start/end date format' });
        }
        params.push(start, end);
        timeClause = `
          recorded_at >= timezone('Asia/Kolkata', $2::date)
          AND recorded_at < timezone('Asia/Kolkata', $3::date + interval '1 day')
        `;
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ error: 'Invalid date format' });
        }
        params.push(date);
        timeClause = `
          recorded_at >= timezone('Asia/Kolkata', $2::date)
          AND recorded_at < timezone('Asia/Kolkata', $2::date + interval '1 day')
        `;
      }

      // ---------------- QUERY ----------------
      let query = `
        SELECT
          recorded_at,
          soc_percent,
          stack_voltage_v,
          battery_status,
          max_voltage_v,
          min_voltage_v,
          avg_voltage_v,
          max_temp_c,
          min_temp_c,
          avg_temp_c,
          battery_current_a,
          charger_current_demand_a,
          charger_voltage_demand_v,
          motor_torque_limit,
          motor_torque_value,
          motor_speed_rpm,
          motor_rotation_dir,
          motor_operation_mode,
          mcu_enable_state,
          motor_ac_current_a,
          motor_ac_voltage_v,
          dc_side_voltage_v,
          motor_temp_c,
          mcu_temp_c,
          radiator_temp_c,
          to_char(total_running_hrs, 'HH24:MI:SS') AS total_running_hrs,
          to_char(last_trip_hrs, 'HH24:MI:SS') AS last_trip_hrs,
          total_kwh_consumed,
          last_trip_kwh,
          dcdc_pri_a_mosfet_temp_c,
          dcdc_sec_ls_mosfet_temp_c,
          dcdc_sec_hs_mosfet_temp_c,
          dcdc_pri_c_mosfet_temp_c,
          dcdc_input_voltage_v,
          dcdc_input_current_a,
          dcdc_output_voltage_v,
          dcdc_output_current_a,
          dcdc_occurence_count,
          btms_command_mode,
          btms_hv_request,
          btms_charge_status,
          bms_hv_relay_state,
          btms_target_temp_c,
          bms_pack_voltage_v,
          bms_life_counter,
          btms_command_crc,
          btms_status_mode,
          btms_hv_relay_state,
          btms_inlet_temp_c,
          btms_outlet_temp_c,
          btms_demand_power_kw,
          motor_status_word,
          motor_freq_raw,
          motor_total_wattage_w,
          motor_dc_input_voltage_raw,
          motor_ac_output_voltage_raw
        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${timeClause}
      `;

      if (cursor) {
        params.push(cursor);
        query += ` AND recorded_at > $${params.length}::timestamptz`;
      }

      query += ` ORDER BY recorded_at ASC LIMIT 200`;

      const result = await db.query(query, params);
      const rows = result?.rows || [];

      const formatted = rows.map(row => ({
        ...row,
        recorded_at_raw: row.recorded_at.toISOString(),
        recorded_at: row.recorded_at.toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
      }));

      res.set('X-Has-More', rows.length === 200 ? 'true' : 'false');
      return res.status(200).json(formatted);

    } catch (err) {
      logger.error(`Database logs error (vehicle ${id}): ${err.message}`);
      return res.status(500).json([]);
    }
  }
);

/**
 * GET /api/database-logs/:id/count
 * Get total row count for progress calculation
 */
router.get(
  '/:id/count',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const { id } = req.params;
    let { date, period, start, end } = req.query;
    const isCustomer = req.user.role === 'customer';

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    if (!date && !period && !(start && end)) {
      return res.status(400).json({ error: 'Missing time range' });
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

      if (ownership.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Build time filter
      let timeClause = '';
      const params = [Number(id)];

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
            return res.status(400).json({ error: 'Invalid period' });
        }
      } else if (start && end) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
          return res.status(400).json({ error: 'Invalid date format' });
        }
        params.push(start, end);
        timeClause = `
          recorded_at >= timezone('Asia/Kolkata', $2::date)
          AND recorded_at < timezone('Asia/Kolkata', $3::date + interval '1 day')
        `;
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ error: 'Invalid date format' });
        }
        params.push(date);
        timeClause = `
          recorded_at >= timezone('Asia/Kolkata', $2::date)
          AND recorded_at < timezone('Asia/Kolkata', $2::date + interval '1 day')
        `;
      }

      const countQuery = `
        SELECT COUNT(*) as total
        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${timeClause}
      `;

      const result = await db.query(countQuery, params);
      const total = parseInt(result.rows[0].total, 10);

      return res.status(200).json({ total });

    } catch (err) {
      logger.error(`Count error (vehicle ${id}): ${err.message}`);
      return res.status(500).json({ error: 'Failed to get count' });
    }
  }
);

/**
 * GET /api/database-logs/:id/export
 * STREAMING CSV export - handles millions of rows without timeout
 */
router.get(
  '/:id/export',
  authenticateToken,
  checkPermission('analytics', 'read'),
  generalLimiter,
  async (req, res) => {
    const { id } = req.params;
    let { date, period, start, end, columns } = req.query;
    const isCustomer = req.user.role === 'customer';

    // Parse selected columns
    let selectedColumns = [];
    if (columns) {
      try {
        selectedColumns = JSON.parse(columns);
      } catch {
        return res.status(400).json({ error: 'Invalid columns format' });
      }
    }

    // ---------------- VALIDATION ----------------
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: 'Invalid vehicle ID' });
    }

    if (!date && !period && !(start && end)) {
      return res.status(400).json({ error: 'Missing time range' });
    }

    let client;

    try {
      // ---------------- OWNERSHIP CHECK ----------------
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

      if (ownership.rows.length === 0) {
        logger.warn(`Export access denied: user ${req.user.email || 'unknown'} for vehicle ${id}`);
        return res.status(403).json({ error: 'Access denied' });
      }

      // ---------------- BUILD TIME FILTER ----------------
      let timeClause = '';
      const params = [Number(id)];

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
            return res.status(400).json({ error: 'Invalid period' });
        }
      } else if (start && end) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
          return res.status(400).json({ error: 'Invalid date format' });
        }
        params.push(start, end);
        timeClause = `
          recorded_at >= timezone('Asia/Kolkata', $2::date)
          AND recorded_at < timezone('Asia/Kolkata', $3::date + interval '1 day')
        `;
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ error: 'Invalid date format' });
        }
        params.push(date);
        timeClause = `
          recorded_at >= timezone('Asia/Kolkata', $2::date)
          AND recorded_at < timezone('Asia/Kolkata', $2::date + interval '1 day')
        `;
      }

      // ---------------- COLUMN SELECTION ----------------
      const allColumnDefs = [
        { key: 'recorded_at', label: 'Timestamp' },
        { key: 'soc_percent', label: 'SOC (%)' },
        { key: 'battery_status', label: 'Battery Status' },
        { key: 'stack_voltage_v', label: 'Stack Voltage (V)' },
        { key: 'battery_current_a', label: 'Battery Current (A)' },
        { key: 'charger_current_demand_a', label: 'Charger Current Demand (A)' },
        { key: 'charger_voltage_demand_v', label: 'Charger Voltage Demand (V)' },
        { key: 'max_voltage_v', label: 'Max Cell Voltage (V)' },
        { key: 'min_voltage_v', label: 'Min Cell Voltage (V)' },
        { key: 'avg_voltage_v', label: 'Avg Cell Voltage (V)' },
        { key: 'max_temp_c', label: 'Max Battery Temp (°C)' },
        { key: 'min_temp_c', label: 'Min Battery Temp (°C)' },
        { key: 'avg_temp_c', label: 'Avg Battery Temp (°C)' },
        { key: 'motor_torque_limit', label: 'Motor Torque Limit (Nm)' },
        { key: 'motor_torque_value', label: 'Motor Torque Value (Nm)' },
        { key: 'motor_speed_rpm', label: 'Motor Speed (RPM)' },
        { key: 'motor_rotation_dir', label: 'Motor Rotation Direction' },
        { key: 'motor_operation_mode', label: 'Motor Operation Mode' },
        { key: 'mcu_enable_state', label: 'MCU Enable State' },
        { key: 'motor_ac_current_a', label: 'Motor AC Current (A)' },
        { key: 'motor_ac_voltage_v', label: 'Motor AC Voltage (V)' },
        { key: 'dc_side_voltage_v', label: 'DC Side Voltage (V)' },
        { key: 'motor_temp_c', label: 'Motor Temperature (°C)' },
        { key: 'mcu_temp_c', label: 'MCU Temperature (°C)' },
        { key: 'radiator_temp_c', label: 'Radiator Temperature (°C)' },
        { key: 'motor_status_word', label: 'Motor Status Word' },
        { key: 'motor_freq_raw', label: 'Motor Frequency Raw' },
        { key: 'motor_total_wattage_w', label: 'Motor Total Wattage (W)' },
        { key: 'motor_dc_input_voltage_raw', label: 'Motor DC Input Voltage Raw' },
        { key: 'motor_ac_output_voltage_raw', label: 'Motor AC Output Voltage Raw' },
        { key: 'btms_command_mode', label: 'BTMS Command Mode' },
        { key: 'btms_status_mode', label: 'BTMS Status Mode' },
        { key: 'btms_hv_request', label: 'BTMS HV Request' },
        { key: 'btms_charge_status', label: 'BTMS Charge Status' },
        { key: 'bms_hv_relay_state', label: 'BMS HV Relay State' },
        { key: 'btms_hv_relay_state', label: 'BTMS HV Relay State' },
        { key: 'btms_target_temp_c', label: 'BTMS Target Temp (°C)' },
        { key: 'btms_inlet_temp_c', label: 'BTMS Inlet Temp (°C)' },
        { key: 'btms_outlet_temp_c', label: 'BTMS Outlet Temp (°C)' },
        { key: 'btms_demand_power_kw', label: 'BTMS Demand Power (kW)' },
        { key: 'bms_pack_voltage_v', label: 'BMS Pack Voltage (V)' },
        { key: 'bms_life_counter', label: 'BMS Life Counter' },
        { key: 'btms_command_crc', label: 'BTMS Command CRC' },
        { key: 'dcdc_pri_a_mosfet_temp_c', label: 'DCDC Pri A MOSFET Temp (°C)' },
        { key: 'dcdc_sec_ls_mosfet_temp_c', label: 'DCDC Sec LS MOSFET Temp (°C)' },
        { key: 'dcdc_sec_hs_mosfet_temp_c', label: 'DCDC Sec HS MOSFET Temp (°C)' },
        { key: 'dcdc_pri_c_mosfet_temp_c', label: 'DCDC Pri C MOSFET Temp (°C)' },
        { key: 'dcdc_input_voltage_v', label: 'DCDC Input Voltage (V)' },
        { key: 'dcdc_input_current_a', label: 'DCDC Input Current (A)' },
        { key: 'dcdc_output_voltage_v', label: 'DCDC Output Voltage (V)' },
        { key: 'dcdc_output_current_a', label: 'DCDC Output Current (A)' },
        { key: 'dcdc_occurence_count', label: 'DCDC Overcurrent Count' },
        { key: 'total_running_hrs', label: 'Total Running Hours' },
        { key: 'last_trip_hrs', label: 'Last Trip Hours' },
        { key: 'total_kwh_consumed', label: 'Total kWh Consumed' },
        { key: 'last_trip_kwh', label: 'Last Trip kWh' },
      ];

      // Filter columns based on selection
      const columnsToExport = selectedColumns.length > 0
        ? allColumnDefs.filter(c => selectedColumns.includes(c.key))
        : allColumnDefs;

      const columnKeys = columnsToExport.map(c => c.key);
      const columnLabels = columnsToExport.map(c => c.label);

      // Build SELECT clause with proper formatting
      const selectFields = columnKeys.map(key => {
        if (key === 'total_running_hrs' || key === 'last_trip_hrs') {
          return `to_char(${key}, 'HH24:MI:SS') AS ${key}`;
        }
        return key;
      }).join(',\n          ');

      // ---------------- STREAMING QUERY ----------------
      const query = `
        SELECT
          ${selectFields}
        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${timeClause}
        ORDER BY recorded_at ASC
      `;

      // Get a dedicated client for cursor-based streaming
      client = await db.getClient();

      // Get total count first for progress tracking
      const countQuery = `
        SELECT COUNT(*) as total
        FROM live_values
        WHERE vehicle_master_id = $1
          AND ${timeClause}
      `;
      const countResult = await db.query(countQuery, params);
      const totalRows = parseInt(countResult.rows[0].total, 10);

      logger.info(`Starting export for vehicle ${id}: ${totalRows} total rows`);

      // Set headers for CSV download
      const filename = `telemetry_${id}_${period || date || `${start}_to_${end}`}_${Date.now()}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Total-Rows', totalRows.toString()); // Send total for progress calculation

      // Write CSV header
      const csvHeader = columnLabels.map(label => `"${label}"`).join(',') + '\n';
      res.write(csvHeader);

      let rowCount = 0;
      let chunkCount = 0;
      const CHUNK_SIZE = 5000; // Process 5000 rows at a time

      // Use cursor for memory-efficient streaming
      const cursorName = `export_cursor_${Date.now()}`;
      await client.query('BEGIN');
      await client.query(`DECLARE ${cursorName} CURSOR FOR ${query}`, params);

      while (true) {
        const { rows } = await client.query(`FETCH ${CHUNK_SIZE} FROM ${cursorName}`);
        
        if (rows.length === 0) break;

        chunkCount++;
        
        // Convert rows to CSV format
        const csvChunk = rows.map(row => {
          return columnKeys.map(key => {
            let val = row[key];
            
            // Format timestamp
            if (key === 'recorded_at' && val) {
              val = val.toLocaleString('en-IN', {
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
            
            // Handle null/undefined
            if (val === null || val === undefined) return '';
            
            // Escape quotes in strings
            return `"${String(val).replace(/"/g, '""')}"`;
          }).join(',');
        }).join('\n') + '\n';

        // Write chunk to response
        res.write(csvChunk);
        rowCount += rows.length;

        // Log progress every 10 chunks (50k rows)
        if (chunkCount % 10 === 0) {
          const percentComplete = ((rowCount / totalRows) * 100).toFixed(1);
          logger.info(`Export progress: ${rowCount}/${totalRows} rows (${percentComplete}%) for vehicle ${id}`);
        }
      }

      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');

      logger.info(`Export completed: ${rowCount} rows for vehicle ${id}`);
      res.end();

    } catch (err) {
      logger.error(`Export error (vehicle ${id}): ${err.message}`);
      
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
        // If headers already sent, just end the stream
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