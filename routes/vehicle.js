// routes/vehicle.js - OPTIMIZED VERSION
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { generalLimiter, liveRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const { formatLiveData } = require('../utils/formatLiveData');

// Shared cache from dedicated service
const {
  liveCache,
  cleanupLiveCache,
  LIVE_CACHE_TTL_MS,
} = require('../services/liveCache');

const router = express.Router();

/* ============================================================
   GET /api/vehicles — List accessible vehicles
   → Only needed columns, customer isolation in one query
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
   GET /api/vehicles/:id — Vehicle summary + latest ODO/kWh
   → Single query with CTEs
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
        WITH vehicle_info AS (
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
        ),
        latest_live AS (
          SELECT 
            total_running_hrs,
            total_kwh_consumed
          FROM live_values
          WHERE vehicle_master_id = $1
          ORDER BY recorded_at DESC
          LIMIT 1
        )
        SELECT 
          vi.*,
          ll.total_running_hrs,
          ll.total_kwh_consumed
        FROM vehicle_info vi
        LEFT JOIN latest_live ll ON true
        `,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'Vehicle not found or access denied' });
      }

      const row = result.rows[0];

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
        vehicle_master_id: row.vehicle_master_id,
        company_name: row.company_name,
        make: row.make,
        model: row.model,
        vehicle_reg_no: row.vehicle_reg_no,
        total_hours: toNumber(intervalToHours(row.total_running_hrs)),
        total_kwh: toNumber(row.total_kwh_consumed),
        date_of_deployment: row.date_of_deployment,
      });
    } catch (err) {
      logger.error(`GET /vehicles/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicles/:id/live — Cached live snapshot
============================================================ */
router.get(
  '/:id/live',
  authenticateToken,
  checkPermission('live_view', 'read'),
  liveRateLimiter,
  async (req, res) => {
    const { id } = req.params;
    const isCustomer = req.user.role === 'customer';
    const cacheKey = `vehicle_live:${id}`;
    const now = Date.now();

    try {
      cleanupLiveCache();
      let entry = liveCache.get(cacheKey);

      // Fast path: valid cache
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      // Ownership check (fast EXISTS)
      const ownership = await db.query(
        `
        SELECT EXISTS(
          SELECT 1
          FROM vehicle_master vm
          JOIN customer_master cm ON vm.customer_id = cm.customer_id
          WHERE vm.vehicle_master_id = $1
            AND ($2::int IS NULL OR cm.user_id = $2)
        ) as allowed
        `,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (!ownership.rows[0]?.allowed) {
        return res.json({});
      }

      // Re-check cache after ownership (race condition safety)
      entry = liveCache.get(cacheKey);
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      // Wait for in-flight request if exists
      if (entry?.inflight) {
        try {
          const data = await Promise.race([
            entry.inflight,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
          ]);
          return res.json(data);
        } catch {
          // timeout → fall through to fresh fetch
        }
      }

      // Start new fetch
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
          logger.error(`Live fetch error for vehicle ${id}: ${err.message}`);
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
   GET /api/vehicles/:id/stream — SSE live stream
============================================================ */
router.get(
  '/:id/stream',
  authenticateToken,
  checkPermission('live_view', 'read'),
  liveRateLimiter,
  async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const isCustomer = user.role === 'customer';

    // Fast ownership check
    try {
      const ownership = await db.query(
        `
        SELECT EXISTS(
          SELECT 1
          FROM vehicle_master vm
          JOIN customer_master cm ON vm.customer_id = cm.customer_id
          WHERE vm.vehicle_master_id = $1
            AND ($2::int IS NULL OR cm.user_id = $2)
        ) as allowed
        `,
        [id, isCustomer ? user.user_id : null]
      );

      if (!ownership.rows[0]?.allowed) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } catch (err) {
      logger.warn(`SSE ownership check failed for vehicle ${id}: ${err.message}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Important for nginx/proxy
    });
    res.flushHeaders();

    logger.info(`🟢 SSE connected → user=${user.email}, vehicle=${id}`);

    const cacheKey = `vehicle_live:${id}`;

    // Send cached value immediately if available
    cleanupLiveCache();
    const cached = liveCache.get(cacheKey);
    if (cached?.data) {
      res.write(`data: ${JSON.stringify(cached.data)}\n\n`);
    }

    let missedUpdates = 0;

    const interval = setInterval(async () => {
      if (res.writableEnded) {
        clearInterval(interval);
        return;
      }

      try {
        cleanupLiveCache();
        const entry = liveCache.get(cacheKey);
        const now = Date.now();

        if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
          res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
          missedUpdates = 0;
          return;
        }

        if (!entry?.inflight) {
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
              logger.error(`SSE fetch error for vehicle ${id}: ${err.message}`);
              return {};
            }
          })();

          liveCache.set(cacheKey, { ts: now, inflight: inflightPromise });

          const data = await inflightPromise;
          liveCache.set(cacheKey, { ts: Date.now(), data });

          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            missedUpdates = 0;
          }
          return;
        }

        try {
          const data = await Promise.race([
            entry.inflight,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
          ]);

          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            missedUpdates = 0;
          }
        } catch {
          missedUpdates++;
          if (missedUpdates > 5) {
            logger.warn(`Too many missed updates → closing SSE for vehicle ${id}`);
            res.end();
          }
        }
      } catch (err) {
        logger.error(`SSE interval error for vehicle ${id}: ${err.message}`);
      }
    }, 1000);

    // Heartbeat to detect dead connections faster
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        try {
          res.write(':\n\n');
        } catch {
          clearInterval(heartbeat);
          clearInterval(interval);
        }
      } else {
        clearInterval(heartbeat);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(interval);
      clearInterval(heartbeat);
      logger.info(`🔴 SSE disconnected → vehicle=${id}`);
    });

    res.on('error', (err) => {
      logger.error(`SSE response error for vehicle ${id}: ${err.message}`);
      clearInterval(interval);
      clearInterval(heartbeat);
    });
  }
);

module.exports = router;