// routes/vehicle.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter, liveRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const { formatLiveData } = require('../utils/formatLiveData');

const router = express.Router();

/* ============================================================
   IN-MEMORY LIVE CACHE (STAMPEDE-PROTECTED, 1.5s TTL)
============================================================ */
const LIVE_CACHE_TTL_MS = 1500;
const liveCache = new Map();

const cleanupLiveCache = () => {
  const now = Date.now();
  for (const [key, entry] of liveCache.entries()) {
    if (!entry?.ts || now - entry.ts > LIVE_CACHE_TTL_MS) {
      liveCache.delete(key);
    }
  }
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
   GET /api/vehicles/:id/live — COMPLETE LIVE DATA (SNAPSHOT)
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

      // Ownership check
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
      } catch (err) {
        logger.warn(`Ownership check failed for vehicle ${id}: ${err.message}`);
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

          if (!result.rows.length) return {};

          return formatLiveData(result.rows[0]);
        } catch (err) {
          logger.error(`Live data fetch error for vehicle ${id}: ${err.message}`);
          return {};
        }
      })();

      liveCache.set(cacheKey, { ts: now, inflight: inflightPromise });

      const data = await inflightPromise;

      liveCache.set(cacheKey, { ts: Date.now(), data });

      res.json(data);
    } catch (err) {
      logger.error(`Unexpected /live error for vehicle ${id}: ${err.message}`);
      res.json({});
    }
  }
);

/* ============================================================
   EXPORT ROUTER — MUST BE AT THE VERY END
============================================================ */
module.exports = router;
