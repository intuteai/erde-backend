// routes/vehicle.js - OPTIMIZED & FIXED VERSION with improved /analytics
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

      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

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

      entry = liveCache.get(cacheKey);
      if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
        return res.json(entry.data);
      }

      if (entry?.inflight) {
        try {
          const data = await Promise.race([
            entry.inflight,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Inflight timeout')), 5000)),
          ]);
          return res.json(data);
        } catch {
          // timeout → fall through
        }
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
   GET /api/vehicles/:id/analytics
   - mode=today
   - OR from=YYYY-MM-DD & to=YYYY-MM-DD
   - Timezone-safe handling (local midnight & end-of-day)
============================================================ */
router.get(
  '/:id/analytics',
  authenticateToken,
  generalLimiter,
  checkPermission('vehicles', 'read'),
  async (req, res) => {
    const { id } = req.params;
    const { mode, from, to } = req.query;
    const isCustomer = req.user.role === 'customer';

    try {
      // 1. Ownership check
      const ownership = await db.query(
        `
        SELECT EXISTS(
          SELECT 1
          FROM vehicle_master vm
          JOIN customer_master cm ON vm.customer_id = cm.customer_id
          WHERE vm.vehicle_master_id = $1
            AND ($2::int IS NULL OR cm.user_id = $2)
        ) AS allowed
        `,
        [id, isCustomer ? req.user.user_id : null]
      );

      if (!ownership.rows[0]?.allowed) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // 2. Resolve time range (timezone-safe: local time)
      let startTime;
      let endTime = new Date();

      if (mode === 'today') {
        startTime = new Date();
        startTime.setHours(0, 0, 0, 0);
      } else if (from && to) {
        startTime = new Date(from);
        startTime.setHours(0, 0, 0, 0);

        endTime = new Date(to);
        endTime.setHours(23, 59, 59, 999);
      } else {
        return res.status(400).json({
          error: 'Invalid request. Use mode=today OR from=YYYY-MM-DD&to=YYYY-MM-DD',
        });
      }

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        return res.status(400).json({ error: 'Invalid date format (use YYYY-MM-DD)' });
      }

      // Optional: ensure start <= end
      if (startTime > endTime) {
        return res.status(400).json({ error: 'Start date cannot be after end date' });
      }

      // 3. Fetch FIRST record in range
      const firstRes = await db.query(
        `
        SELECT total_running_hrs, total_kwh_consumed
        FROM live_values
        WHERE vehicle_master_id = $1
          AND recorded_at >= $2
        ORDER BY recorded_at ASC
        LIMIT 1
        `,
        [id, startTime]
      );

      // 4. Fetch LAST record in range
      const lastRes = await db.query(
        `
        SELECT total_running_hrs, total_kwh_consumed
        FROM live_values
        WHERE vehicle_master_id = $1
          AND recorded_at <= $2
        ORDER BY recorded_at DESC
        LIMIT 1
        `,
        [id, endTime]
      );

      if (!firstRes.rows.length || !lastRes.rows.length) {
        return res.json({
          vehicle_master_id: Number(id),
          mode: mode === 'today' ? 'today' : 'custom',
          from: startTime.toISOString(),
          to: endTime.toISOString(),
          running_hours: 0,
          kwh_consumed: 0,
          avg_kwh: null,
        });
      }

      // 5. Compute deltas
      const first = firstRes.rows[0];
      const last = lastRes.rows[0];

      const intervalToHours = (interval) => {
        if (!interval) return 0;
        const { days = 0, hours = 0, minutes = 0, seconds = 0 } = interval;
        return days * 24 + hours + minutes / 60 + seconds / 3600;
      };

      const firstHours = intervalToHours(first.total_running_hrs);
      const lastHours = intervalToHours(last.total_running_hrs);

      const runningHours = Math.max(0, lastHours - firstHours);
      const kwhConsumed =
        last.total_kwh_consumed !== null && first.total_kwh_consumed !== null
          ? Math.max(0, Number(last.total_kwh_consumed) - Number(first.total_kwh_consumed))
          : 0;

      const avgKwh = runningHours > 0 ? Number((kwhConsumed / runningHours).toFixed(2)) : null;

      // 6. Response
      res.json({
        vehicle_master_id: Number(id),
        mode: mode === 'today' ? 'today' : 'custom',
        from: startTime.toISOString(),
        to: endTime.toISOString(),
        running_hours: Number(runningHours.toFixed(2)),
        kwh_consumed: Number(kwhConsumed.toFixed(2)),
        avg_kwh: avgKwh,
      });
    } catch (err) {
      logger.error(`GET /vehicles/${id}/analytics error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
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
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    logger.info(`🟢 SSE connected → user=${user.email}, vehicle=${id}`);

    const cacheKey = `vehicle_live:${id}`;

    cleanupLiveCache();
    let entry = liveCache.get(cacheKey);
    if (entry?.data) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
      }
    }

    let missedUpdates = 0;

    const interval = setInterval(async () => {
      if (res.writableEnded) {
        clearInterval(interval);
        return;
      }

      try {
        cleanupLiveCache();
        entry = liveCache.get(cacheKey);
        const now = Date.now();

        if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
          }
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

          const data = await Promise.race([
            inflightPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), 5000)),
          ]);

          liveCache.set(cacheKey, { ts: Date.now(), data });

          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
          missedUpdates = 0;
          return;
        }

        try {
          const data = await Promise.race([
            entry.inflight,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Inflight timeout')), 3000)),
          ]);

          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
          missedUpdates = 0;
        } catch (err) {
          missedUpdates++;
          if (missedUpdates > 5) {
            logger.warn(`Too many missed updates (${missedUpdates}) → closing SSE for vehicle ${id}`);
            if (!res.writableEnded) res.end();
            clearInterval(interval);
            return;
          }
        }
      } catch (err) {
        logger.error(`SSE interval error for vehicle ${id}: ${err.message}`);
      }
    }, 1000);

    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(':\n\n');
      } catch {
        clearInterval(heartbeat);
        clearInterval(interval);
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