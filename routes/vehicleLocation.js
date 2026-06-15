// routes/vehicleLocation.js
const express = require('express');
const db = require('../config/postgres');

const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const { liveRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const {
  liveCache,
  cleanupLiveCache,
  LIVE_CACHE_TTL_MS,
} = require('../services/liveCache');

const router = express.Router();

/* ============================================================
   Helpers
============================================================ */

/** Format DB row → SSE payload */
function formatLocationData(row) {
  if (!row) return null;

  return {
    lat: Number(row.lat),
    lon: Number(row.lon),
    recorded_at: row.recorded_at,
    accuracy_m: row.accuracy_m != null ? Number(row.accuracy_m) : null,
    speed_mps: row.speed_mps != null ? Number(row.speed_mps) : null,
    heading_deg: row.heading_deg != null ? Number(row.heading_deg) : null,
    alt_m: row.alt_m != null ? Number(row.alt_m) : null,
    source: row.source,
  };
}

/** Simple anti-teleport guard (meters) */
function haversineMeters(a, b) {
  if (!a || !b) return 0;
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ============================================================
   GET /api/vehicles/:id/location/stream
============================================================ */
router.get(
  '/:id/location/stream',
  authenticateToken, // reads HttpOnly cookie (primary) or Authorization header
  checkPermission('live_view', 'read'),
  liveRateLimiter,
  async (req, res) => {
    const { id } = req.params;
    const user = req.user;
    const isCustomer = user.role === 'customer';

    /* ---------------- Ownership check ---------------- */
    try {
      const ownership = await db.query(
        `
        SELECT 1
        FROM vehicle_master vm
        JOIN customer_master cm ON vm.customer_id = cm.customer_id
        WHERE vm.vehicle_master_id = $1
          AND ($2::int IS NULL OR cm.user_id = $2)
        `,
        [id, isCustomer ? user.user_id : null]
      );

      if (ownership.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } catch (err) {
      logger.warn(
        `Location SSE ownership check failed for vehicle ${id}: ${err.message}`
      );
      return res.status(403).json({ error: 'Access denied' });
    }

    /* ---------------- SSE headers ---------------- */
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    logger.info(
      `🟢 Location SSE connected → user=${user.email}, vehicle=${id}`
    );

    const cacheKey = `vehicle_location:${id}`;
    let lastSent = null;

    cleanupLiveCache();

    /* ---------------- Initial snapshot (DB) ---------------- */
    try {
      const snap = await db.query(
        `
        SELECT
          lat, lon, recorded_at,
          accuracy_m, speed_mps, heading_deg, alt_m, source
        FROM vehicle_location
        WHERE vehicle_master_id = $1
        ORDER BY recorded_at DESC
        LIMIT 1
        `,
        [id]
      );

      if (snap.rows.length) {
        const data = formatLocationData(snap.rows[0]);
        lastSent = data;
        liveCache.set(cacheKey, { ts: Date.now(), data });
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    } catch (err) {
      logger.warn(`Initial location snapshot failed: ${err.message}`);
    }

    /* ---------------- Poll loop ---------------- */
    const interval = setInterval(async () => {
      try {
        cleanupLiveCache();
        const now = Date.now();
        const entry = liveCache.get(cacheKey);

        // Fresh cache
        if (entry?.data && now - entry.ts < LIVE_CACHE_TTL_MS) {
          if (
            !lastSent ||
            entry.data.recorded_at !== lastSent.recorded_at
          ) {
            lastSent = entry.data;
            res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
          }
          return;
        }

        // Inflight fetch
        if (!entry?.inflight) {
          const inflight = (async () => {
            const result = await db.query(
              `
              SELECT
                lat, lon, recorded_at,
                accuracy_m, speed_mps, heading_deg, alt_m, source
              FROM vehicle_location
              WHERE vehicle_master_id = $1
              ORDER BY recorded_at DESC
              LIMIT 1
              `,
              [id]
            );

            if (!result.rows.length) return null;
            return formatLocationData(result.rows[0]);
          })();

          liveCache.set(cacheKey, { ts: now, inflight });

          const data = await inflight;
          if (!data) return;

          // Anti-teleport guard (2km / second)
          if (
            lastSent &&
            haversineMeters(lastSent, data) > 2000
          ) {
            logger.warn(`GPS jump ignored for vehicle ${id}`);
            return;
          }

          liveCache.set(cacheKey, { ts: Date.now(), data });

          if (
            !lastSent ||
            data.recorded_at !== lastSent.recorded_at
          ) {
            lastSent = data;
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        }
      } catch (err) {
        logger.error(
          `Location SSE interval error for vehicle ${id}: ${err.message}`
        );
      }
    }, 1000);

    /* ---------------- Heartbeat ---------------- */
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(':\n\n');
    }, 15000);

    /* ---------------- Cleanup ---------------- */
    req.on('close', () => {
      clearInterval(interval);
      clearInterval(heartbeat);
      liveCache.delete(cacheKey);
      logger.info(`🔴 Location SSE disconnected → vehicle=${id}`);
    });
  }
);

module.exports = router;
