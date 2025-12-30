const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter, liveRateLimiter } = require('../middleware/rateLimiter'); // Import both
const logger = require('../utils/logger');

const router = express.Router();

/* ============================================================
   IN-MEMORY LIVE CACHE (FULLY STAMPEDE-PROTECTED)
   - Short TTL (1.5s)
   - True in-flight deduplication (race-safe)
   - Only caches valid/owned vehicles
============================================================ */
const LIVE_CACHE_TTL_MS = 1500;
const liveCache = new Map(); // key: `vehicle_live:${id}`

const EMPTY_LIVE_RESPONSE = {
  soc_percent: null,
  battery_status: null,
  stack_voltage_v: null,
  dc_current_a: null,
  motor_speed_rpm: null,
  motor_temp_c: null,
  mcu_temp_c: null,
  total_hours: null,
  last_trip_hrs: null,
  total_kwh: null,
  last_trip_kwh: null,
  output_power_kw: null,
  alarms_ac_hall_failure: false,
  alarms_bus_overvoltage_fault: false,
  alarms_busbar_undervoltage_fault: false,
  alarms_can_offline_failure: false,
  alarms_encoder_failure: false,
  alarms_fan_failure: false,
  alarms_hardware_driver_failure: false,
  alarms_hardware_overcurrent_fault: false,
  alarms_hardware_overvoltage_fault: false,
  alarms_low_voltage_undervoltage_fault: false,
  alarms_module_over_temperature_fault: false,
  alarms_module_over_temperature_warning: false,
  alarms_motor_over_temperature_fault: false,
  alarms_motor_over_temperature_warning: false,
  alarms_over_rpm_alarm_flag: false,
  alarms_overspeed_fault: false,
  alarms_software_overcurrent_fault: false,
  alarms_stall_failure: false,
  alarms_temperature_difference_failure: false,
  alarms_total_hardware_failure: false,
  alarms_zero_offset_fault: false,
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

const clamp = (v, min, max) => {
  if (v === null) return null;
  return Math.min(Math.max(v, min), max);
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
   CACHE CLEANUP HELPER
============================================================ */
const cleanupLiveCache = () => {
  const now = Date.now();
  for (const [key, entry] of liveCache.entries()) {
    if (!entry?.ts || now - entry.ts > LIVE_CACHE_TTL_MS) {
      liveCache.delete(key);
    }
  }
};

/* ============================================================
   GET /api/vehicles - List all accessible vehicles
   ORDER: auth → rate limit → permission → handler
============================================================ */
router.get(
  '/',
  authenticateToken,
  generalLimiter,                          // ← Moved here (after auth, before permission)
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
   GET /api/vehicles/:id - Vehicle summary
   Added generalLimiter for consistency
============================================================ */
router.get(
  '/:id',
  authenticateToken,
  generalLimiter,                          // ← Added rate limiting
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
        `
        SELECT total_running_hrs, total_kwh_consumed
        FROM live_values
        WHERE vehicle_master_id = $1
        ORDER BY recorded_at DESC
        LIMIT 1
        `,
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
        total_kwh: clamp(toNumber(l.total_kwh_consumed), 0, 1e6),
        date_of_deployment: result.rows[0].date_of_deployment,
      });
    } catch (err) {
      logger.error(`GET /vehicles/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/live - High-frequency live data
   liveRateLimiter is correctly placed after auth & permission
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
      let entry = getEntry();
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      let allowed = false;
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
        allowed = ownership.rows.length > 0;
      } catch (ownershipErr) {
        logger.warn(`Ownership check failed for vehicle ${id}: ${ownershipErr.message}`);
      }

      if (!allowed) {
        return res.json({});
      }

      entry = getEntry();
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      if (entry?.inflight) {
        const data = await entry.inflight;
        return res.json(data);
      }

      const inflightPromise = (async () => {
        try {
          const result = await db.query(
            `
            SELECT *
            FROM live_values
            WHERE vehicle_master_id = $1
            ORDER BY recorded_at DESC
            LIMIT 1
            `,
            [id]
          );

          let response = { ...EMPTY_LIVE_RESPONSE };

          if (result.rows.length > 0) {
            const r = result.rows[0];

            response = {
              soc_percent: clamp(toNumber(r.soc_percent), 0, 100),
              battery_status: r.battery_status ?? null,
              stack_voltage_v: clamp(toNumber(r.stack_voltage_v), 0, 1000),
              dc_current_a: clamp(toNumber(r.battery_current_a), -2000, 2000),
              motor_speed_rpm: toNumber(r.motor_speed_rpm),
              motor_temp_c: clamp(toNumber(r.motor_temp_c), -50, 200),
              mcu_temp_c: clamp(toNumber(r.mcu_temp_c), -50, 200),
              total_hours: toNumber(intervalToHours(r.total_running_hrs)),
              last_trip_hrs: toNumber(intervalToHours(r.last_trip_hrs)),
              total_kwh: clamp(toNumber(r.total_kwh_consumed), 0, 1e6),
              last_trip_kwh: clamp(toNumber(r.last_trip_kwh), 0, 1e5),
              output_power_kw: null,
            };

            if (response.stack_voltage_v != null && response.dc_current_a != null) {
              response.output_power_kw = clamp(
                (response.stack_voltage_v * response.dc_current_a) / 1000,
                -1000,
                1000
              );
            }

            Object.assign(response, flattenAlarms(r.alarms));
          }

          liveCache.set(cacheKey, { ts: Date.now(), data: response });
          return response;
        } catch (fetchErr) {
          logger.error(`Live data fetch failed for vehicle ${id}: ${fetchErr.message}`);
          const fallback = { ...EMPTY_LIVE_RESPONSE };
          liveCache.set(cacheKey, { ts: Date.now(), data: fallback });
          return fallback;
        } finally {
          const current = getEntry();
          if (current?.inflight === inflightPromise) {
            const { data } = current;
            liveCache.set(cacheKey, { ts: current.ts || now, data });
          }
        }
      })();

      liveCache.set(cacheKey, { ts: now, inflight: inflightPromise });

      const data = await inflightPromise;
      res.json(data);
    } catch (outerErr) {
      logger.error(`Unexpected error in /vehicles/:id/live: ${outerErr.message}`);

      const entry = getEntry();
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      res.json({});
    }
  }
);

module.exports = router;