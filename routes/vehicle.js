// routes/vehicle.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter, liveRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

/* ============================================================
   IN-MEMORY LIVE CACHE (STAMPEDE-PROTECTED, 1.5s TTL)
============================================================ */
const LIVE_CACHE_TTL_MS = 1500;
const liveCache = new Map(); // key: `vehicle_live:${id}`

const cleanupLiveCache = () => {
  const now = Date.now();
  for (const [key, entry] of liveCache.entries()) {
    if (!entry?.ts || now - entry.ts > LIVE_CACHE_TTL_MS) {
      liveCache.delete(key);
    }
  }
};

/* ============================================================
   HELPERS
============================================================ */
const intervalToHours = (interval) => {
  if (!interval) return null;
  const { days = 0, hours = 0, minutes = 0, seconds = 0 } = interval;
  return days * 24 + hours + minutes / 60 + seconds / 3600;
};

const toNumber = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const flattenAlarms = (alarms, out = {}) => {
  if (!alarms || typeof alarms !== 'object') return out;
  for (const [k, v] of Object.entries(alarms)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenAlarms(v, out);
    } else {
      out[`alarms_${k}`] = Boolean(v);
    }
  }
  return out;
};

/* ============================================================
   GET /api/vehicles — List accessible vehicles
============================================================ */
router.get(
  '/',
  authenticateToken,
  generalLimiter,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    try {
      const isCustomer = req.user.role === 'customer';
      const result = await db.query(
        `
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_unique_id,
          vm.vehicle_reg_no,
          vm.vehicle_type,
          cm.company_name,
          vt.make,
          vt.model,
          vm.vcu_make_model,
          vm.hmi_make_model,
          vm.date_of_deployment
        FROM vehicle_master vm
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
        WHERE ($1::int IS NULL OR cm.user_id = $1)
        ORDER BY vm.vehicle_unique_id
        `,
        [isCustomer ? req.user.user_id : null]
      );
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /vehicles error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id — Vehicle summary + ODO
============================================================ */
router.get(
  '/:id',
  authenticateToken,
  generalLimiter,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    const { id } = req.params;
    const isCustomer = req.user.role === 'customer';
    try {
      const result = await db.query(
        `
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_reg_no,
          cm.company_name,
          vt.make,
          vt.model,
          vm.date_of_deployment
        FROM vehicle_master vm
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
        WHERE vm.vehicle_master_id = $1
          AND ($2::int IS NULL OR cm.user_id = $2)
        `,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }

      const live = await db.query(
        `SELECT total_running_hrs, total_kwh_consumed
         FROM live_values
         WHERE vehicle_master_id = $1
         ORDER BY recorded_at DESC
         LIMIT 1`,
        [id]
      );

      const l = live.rows[0] || {};

      res.json({
        vehicle_master_id: result.rows[0].vehicle_master_id,
        company_name: result.rows[0].company_name,
        make: result.rows[0].make,
        model: result.rows[0].model,
        vehicle_reg_no: result.rows[0].vehicle_reg_no,
        total_hours: toNumber(intervalToHours(l.total_running_hrs)),
        total_kwh: toNumber(l.total_kwh_consumed),
        date_of_deployment: result.rows[0].date_of_deployment,
      });
    } catch (err) {
      logger.error(`GET /vehicles/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/live — COMPLETE LIVE DATA
============================================================ */
router.get(
  '/:id/live',
  authenticateToken,
  checkPermission('live_view', 'read'),
  liveRateLimiter,
  async (req, res) => {
    cleanupLiveCache();

    const { id } = req.params;
    const isCustomer = req.user.role === 'customer';
    const cacheKey = `vehicle_live:${id}`;
    const now = Date.now();
    const getEntry = () => liveCache.get(cacheKey);

    try {
      // Return cached data if fresh
      let entry = getEntry();
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      // Ownership check
      let allowed = false;
      try {
        const ownership = await db.query(
          `SELECT 1 FROM vehicle_master vm
           JOIN customer_master cm ON vm.customer_id = cm.customer_id
           WHERE vm.vehicle_master_id = $1
             AND ($2::int IS NULL OR cm.user_id = $2)`,
          [id, isCustomer ? req.user.user_id : null]
        );
        allowed = ownership.rows.length > 0;
      } catch (err) {
        logger.warn(`Ownership check failed for vehicle ${id}: ${err.message}`);
      }

      if (!allowed) {
        return res.json({});
      }

      // Check cache again after ownership
      entry = getEntry();
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      // In-flight deduplication
      if (entry?.inflight) {
        const data = await entry.inflight;
        return res.json(data);
      }

      const inflightPromise = (async () => {
        try {
          const result = await db.query(
            `SELECT * FROM live_values
             WHERE vehicle_master_id = $1
             ORDER BY recorded_at DESC
             LIMIT 1`,
            [id]
          );

          if (!result.rows.length) {
            return {};
          }

          const r = result.rows[0];

          const response = {
            // Battery Core
            soc_percent: toNumber(r.soc_percent),
            battery_status: r.battery_status ?? null,
            stack_voltage_v: toNumber(r.stack_voltage_v),
            dc_current_a: toNumber(r.battery_current_a),
            charging_current_a: toNumber(r.charger_current_demand_a),

            // Module Sensors (full arrays preserved)
            temp_sensors: (r.temp_sensors || []).map(toNumber),
            cell_voltages: (r.cell_voltages || []).map(toNumber),

            // Motor & MCU
            motor_torque_nm: toNumber(r.motor_torque_value),
            motor_torque_limit: toNumber(r.motor_torque_limit),
            motor_operation_mode: r.motor_operation_mode ?? null,
            motor_speed_rpm: toNumber(r.motor_speed_rpm),
            motor_rotation_dir: r.motor_rotation_dir ?? null,
            ac_current_a: toNumber(r.motor_ac_current_a),
            motor_ac_voltage_v: toNumber(r.motor_ac_voltage_v),
            mcu_enable_state: r.mcu_enable_state ?? null,
            motor_temp_c: toNumber(r.motor_temp_c),
            mcu_temp_c: toNumber(r.mcu_temp_c),

            // Peripherals
            radiator_temp_c: toNumber(r.radiator_temp_c),

            // ODO & Energy
            total_hours: intervalToHours(r.total_running_hrs),
            last_trip_hrs: intervalToHours(r.last_trip_hrs),
            total_kwh: toNumber(r.total_kwh_consumed),
            last_trip_kwh: toNumber(r.last_trip_kwh),

            // DC-DC Converter (ALL fields included)
            dcdc_input_voltage_v: toNumber(r.dcdc_input_voltage_v),
            dcdc_input_current_a: toNumber(r.dcdc_input_current_a),
            dcdc_output_voltage_v: toNumber(r.dcdc_output_voltage_v),
            dcdc_output_current_a: toNumber(r.dcdc_output_current_a),
            dcdc_pri_a_mosfet_temp_c: toNumber(r.dcdc_pri_a_mosfet_temp_c),
            dcdc_pri_c_mosfet_temp_c: toNumber(r.dcdc_pri_c_mosfet_temp_c),
            dcdc_sec_ls_mosfet_temp_c: toNumber(r.dcdc_sec_ls_mosfet_temp_c),
            dcdc_sec_hs_mosfet_temp_c: toNumber(r.dcdc_sec_hs_mosfet_temp_c),
            dcdc_occurrence_count: toNumber(r.dcdc_occurence_count) ?? null, // spelling fixed for frontend

            // Calculated output power
            output_power_kw: null,
          };

          // Calculate output power safely
          if (response.stack_voltage_v != null && response.dc_current_a != null) {
            response.output_power_kw = (response.stack_voltage_v * response.dc_current_a) / 1000;
          }

          // Flatten alarms from JSONB
          Object.assign(response, flattenAlarms(r.alarms));

          return response;
        } catch (err) {
          logger.error(`Live data fetch error for vehicle ${id}: ${err.message}`);
          return {};
        }
      })();

      // Store inflight promise
      liveCache.set(cacheKey, { ts: now, inflight: inflightPromise });

      const data = await inflightPromise;

      // Cache final result
      liveCache.set(cacheKey, { ts: Date.now(), data });

      res.json(data);
    } catch (err) {
      logger.error(`Unexpected /live error for vehicle ${id}: ${err.message}`);
      res.json({});
    }
  }
);

module.exports = router;