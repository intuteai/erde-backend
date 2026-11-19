// routes/vehicle-master.js
const express = require('express');
const router  = express.Router();
const db      = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission   = require('../middleware/checkPermission');
const logger = require('../utils/logger');
const { liveCache, cleanupLiveCache } = require('../services/liveCache');
const { liveRateLimiter } = require('../middleware/rateLimiter');

/* =========================
   HELPERS
========================= */
// Measured live over a real 24h window of live_values: normal telemetry
// cadence is a rock-solid ~2-4s (p99 across every vehicle), but genuine
// brief hiccups up to ~22s do happen, with the next real outage tier
// starting around ~205s+ — nothing in between. 15s sat inside that first
// gap, so a vehicle with nothing actually wrong would flicker
// online->idle->online on a brief hiccup. 30s clears every observed
// hiccup with margin while still catching every genuine outage promptly;
// IDLE_THRESHOLD_MS already sits safely inside the same gap unchanged.
const ONLINE_THRESHOLD_MS = 30 * 1000;   // 30 seconds
const IDLE_THRESHOLD_MS   = 60 * 1000;   // 1 minute
const SUMMARY_POLL_INTERVAL_MS = 2000;   // same cadence as the fleet-location stream

/**
 * Returns 'online' | 'idle' | 'offline' based on the last_seen timestamp.
 */
const getVehicleStatus = (lastSeen) => {
  if (!lastSeen) return 'offline';
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  if (diffMs <= ONLINE_THRESHOLD_MS) return 'online';
  if (diffMs <= IDLE_THRESHOLD_MS)   return 'idle';
  return 'offline';
};

/* ============================================================
   1. GET /api/vehicle-master/admin-summary
   Uses vehicle_latest_snapshot for O(1) reads — never scans live_values.
============================================================ */
router.get(
  '/admin-summary',
  authenticateToken,
  checkPermission('vehicle_master', 'read'),
  async (req, res) => {
    // Defense in depth: this query has no customer/user scoping at all (it's
    // meant to show the whole fleet to admins), so it must not rely solely
    // on checkPermission — that middleware fails OPEN on a read-permission
    // DB error (see middleware/checkPermission.js), which would otherwise
    // let a 'customer'-role account see every other customer's vehicles
    // during exactly that kind of transient failure.
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const result = await db.query(`
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_reg_no,
          cm.company_name          AS customer,
          vt.make                  AS vehicle_make,
          vt.model                 AS vehicle_model,
          vt.capacity_tonne        AS capacity,
          vls.last_seen,
          CASE
            WHEN vls.total_running_hrs IS NOT NULL
            THEN ROUND(EXTRACT(EPOCH FROM vls.total_running_hrs) / 3600.0, 2)
            ELSE NULL
          END                      AS total_hours,
          ROUND(vls.total_kwh_consumed, 2) AS total_kwh,
          ROUND(vls.avg_kwh, 2)            AS avg_kwh,
          vls.battery_status
        FROM vehicle_master vm
        JOIN customer_master cm     ON vm.customer_id = cm.customer_id
        JOIN vehicle_type_master vt ON vm.vtype_id    = vt.vtype_id
        LEFT JOIN vehicle_latest_snapshot vls
          ON vls.vehicle_master_id = vm.vehicle_master_id
        ORDER BY vm.vehicle_master_id ASC
      `);

      const data = result.rows.map(row => ({
        vehicle_master_id: row.vehicle_master_id,
        vehicle_no:   row.vehicle_reg_no || '—',
        customer:     row.customer       || '—',
        vehicle_type: `${row.vehicle_make || ''} ${row.vehicle_model || ''}`.trim() || '—',
        capacity:     row.capacity       ?? '—',
        total_hours:  row.total_hours,
        total_kwh:    row.total_kwh,
        avg_kwh:      row.avg_kwh,
        status:       getVehicleStatus(row.last_seen),
        charging_status: row.battery_status || null,
        last_seen:    row.last_seen,
      }));

      res.json(data);
    } catch (err) {
      logger.error('GET /vehicle-master/admin-summary error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicle-master/admin-summary/stream
   SSE: pushes one event per vehicle whenever its status/hours/kWh
   actually changes. Same poll+fingerprint+shared-cache architecture
   as /api/vehicles/locations/stream — one query for the whole fleet
   every SUMMARY_POLL_INTERVAL_MS, shared across every open admin
   viewer via liveCache, only emitting for vehicles that changed.

   Always admin-only (same reasoning as /admin-summary above — this
   query has no customer scoping, so it must not rely solely on
   checkPermission's fail-open-on-DB-error read behavior).
============================================================ */
router.get(
  '/admin-summary/stream',
  authenticateToken,
  checkPermission('vehicle_master', 'read'),
  liveRateLimiter,
  async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Single shared cache key — unlike fleet locations (scoped per customer),
    // admin-summary is always the identical full-fleet query for every
    // admin viewer, so there's exactly one cache entry to share.
    const cacheKey = 'admin_summary_stream';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    logger.info(`🟢 Admin-summary SSE connected → user=${req.user.email}`);

    const lastSent = new Map(); // vehicle_master_id -> last-sent fingerprint, per connection
    // Tracks which vehicle_master_ids this connection has seen, so an
    // addition or removal (not just a changed field on an existing
    // vehicle) can be detected and signaled separately — per-vehicle
    // fingerprinting alone can't tell the client "the row SET changed",
    // since there's no fingerprint for a row that doesn't exist yet.
    // null on the first poll means "no baseline yet, don't fire a signal
    // for it" — otherwise every connection would send an immediate,
    // redundant refetch signal right after the client's own initial fetch.
    let knownIds = null;

    const fetchSummaryRows = async () => {
      const result = await db.query(`
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_reg_no,
          cm.company_name          AS customer,
          vt.make                  AS vehicle_make,
          vt.model                 AS vehicle_model,
          vt.capacity_tonne        AS capacity,
          vls.last_seen,
          CASE
            WHEN vls.total_running_hrs IS NOT NULL
            THEN ROUND(EXTRACT(EPOCH FROM vls.total_running_hrs) / 3600.0, 2)
            ELSE NULL
          END                      AS total_hours,
          ROUND(vls.total_kwh_consumed, 2) AS total_kwh,
          ROUND(vls.avg_kwh, 2)            AS avg_kwh,
          vls.battery_status
        FROM vehicle_master vm
        JOIN customer_master cm     ON vm.customer_id = cm.customer_id
        JOIN vehicle_type_master vt ON vm.vtype_id    = vt.vtype_id
        LEFT JOIN vehicle_latest_snapshot vls
          ON vls.vehicle_master_id = vm.vehicle_master_id
        ORDER BY vm.vehicle_master_id ASC
      `);
      return result.rows;
    };

    const poll = async () => {
      if (res.writableEnded) return;

      try {
        cleanupLiveCache();
        const now = Date.now();
        const entry = liveCache.get(cacheKey);

        let rows;
        if (entry?.data && now - entry.ts < SUMMARY_POLL_INTERVAL_MS) {
          rows = entry.data;
        } else if (entry?.inflight) {
          rows = await entry.inflight;
        } else {
          const inflight = fetchSummaryRows();
          liveCache.set(cacheKey, { ts: now, inflight });
          rows = await inflight;
          liveCache.set(cacheKey, { ts: Date.now(), data: rows });
        }

        const currentIds = new Set(rows.map((r) => r.vehicle_master_id));
        if (knownIds !== null) {
          const changed =
            currentIds.size !== knownIds.size ||
            [...currentIds].some((id) => !knownIds.has(id));
          if (changed && !res.writableEnded) {
            // Signals "the row set itself changed" (a vehicle was added or
            // removed) — distinguishable from a normal per-vehicle update by
            // having no vehicle_master_id. The client re-fetches via REST to
            // get complete data for the new/changed set rather than trying
            // to live-patch a table row from a bare id.
            res.write(`data: ${JSON.stringify({ type: 'refetch' })}\n\n`);
          }
        }
        knownIds = currentIds;

        for (const row of rows) {
          const lastSeenIso = row.last_seen ? new Date(row.last_seen).toISOString() : null;
          // Status is a function of wall-clock time, not just last_seen — a
          // vehicle that goes quiet has an unchanging last_seen/total_hours/
          // total_kwh, but getVehicleStatus(last_seen) still transitions
          // online -> idle -> offline as time passes. It must be part of the
          // fingerprint (and computed once, here, before the dedup check),
          // or that transition is computed correctly on every poll but never
          // reaches the client — confirmed live: a vehicle stopped and the
          // dashboard kept showing it online indefinitely.
          const status = getVehicleStatus(row.last_seen);
          const fingerprint = `${lastSeenIso}|${row.total_hours}|${row.total_kwh}|${row.avg_kwh}|${status}|${row.battery_status}`;

          if (lastSent.get(row.vehicle_master_id) === fingerprint) continue;
          lastSent.set(row.vehicle_master_id, fingerprint);

          const payload = {
            vehicle_master_id: row.vehicle_master_id,
            vehicle_no:   row.vehicle_reg_no || '—',
            customer:     row.customer       || '—',
            vehicle_type: `${row.vehicle_make || ''} ${row.vehicle_model || ''}`.trim() || '—',
            capacity:     row.capacity       ?? '—',
            total_hours:  row.total_hours,
            total_kwh:    row.total_kwh,
            avg_kwh:      row.avg_kwh,
            status,
            charging_status: row.battery_status || null,
            last_seen:    row.last_seen,
          };

          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
        }
      } catch (err) {
        logger.error(`Admin-summary SSE poll error: ${err.message}`);
      }
    };

    await poll(); // send current state immediately on connect

    const interval = setInterval(poll, SUMMARY_POLL_INTERVAL_MS);

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
      // Deliberately not liveCache.delete(cacheKey) — shared across every
      // admin viewer, same reasoning as the fleet-location stream.
      logger.info(`🔴 Admin-summary SSE disconnected → user=${req.user.email}`);
    });
  }
);

/* ============================================================
   2. GET /api/vehicle-master/my
   Customer-facing fleet list. Uses vehicle_latest_snapshot.
============================================================ */
router.get(
  '/my',
  authenticateToken,
  checkPermission('vehicle_master', 'read'),
  async (req, res) => {
    try {
      const custRes = await db.query(
        `SELECT customer_id FROM customer_master WHERE user_id = $1`,
        [req.user.user_id]
      );

      if (!custRes.rows.length) {
        return res.status(404).json({ error: 'Customer profile not found' });
      }

      const customerId = custRes.rows[0].customer_id;

      const result = await db.query(`
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_reg_no,
          vm.date_of_deployment::text AS date_of_deployment,
          vt.make                     AS vehicle_make,
          vt.model                    AS vehicle_model,
          vt.capacity_tonne           AS capacity,
          vm.vcu_make_model,
          vm.hmi_make_model,
          vls.last_seen,
          CASE
            WHEN vls.total_running_hrs IS NOT NULL
            THEN ROUND(EXTRACT(EPOCH FROM vls.total_running_hrs) / 3600.0, 2)
            ELSE NULL
          END                         AS total_hours,
          ROUND(vls.total_kwh_consumed, 2) AS total_kwh,
          ROUND(vls.avg_kwh, 2)            AS avg_kwh
        FROM vehicle_master vm
        JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
        LEFT JOIN vehicle_latest_snapshot vls
          ON vls.vehicle_master_id = vm.vehicle_master_id
        WHERE vm.customer_id = $1
        ORDER BY vm.vehicle_master_id ASC
      `, [customerId]);

      const data = result.rows.map(row => ({
        vehicle_master_id:  row.vehicle_master_id,
        vehicle_reg_no:     row.vehicle_reg_no    || '—',
        vehicle_make:       row.vehicle_make       || '',
        vehicle_model:      row.vehicle_model      || '',
        capacity:           row.capacity           ?? '—',
        vcu_make_model:     row.vcu_make_model,
        hmi_make_model:     row.hmi_make_model,
        date_of_deployment: row.date_of_deployment,
        total_hours:        row.total_hours,
        total_kwh:          row.total_kwh,
        avg_kwh:            row.avg_kwh,
        status:             getVehicleStatus(row.last_seen),
        last_seen:          row.last_seen,
      }));

      res.json(data);
    } catch (err) {
      logger.error('GET /vehicle-master/my error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET /api/vehicle-master/my/stream
   SSE equivalent of /my, same poll+fingerprint+shared-cache
   architecture as admin-summary/stream above, scoped to the
   caller's own customer_id (same lookup as /my itself).
============================================================ */
router.get(
  '/my/stream',
  authenticateToken,
  checkPermission('vehicle_master', 'read'),
  liveRateLimiter,
  async (req, res) => {
    let customerId;
    try {
      const custRes = await db.query(
        `SELECT customer_id FROM customer_master WHERE user_id = $1`,
        [req.user.user_id]
      );
      if (!custRes.rows.length) {
        return res.status(404).json({ error: 'Customer profile not found' });
      }
      customerId = custRes.rows[0].customer_id;
    } catch (err) {
      logger.error(`My-vehicles SSE customer lookup error: ${err.message}`);
      return res.status(500).json({ error: 'Server error' });
    }

    // Shared across every open connection for THIS customer (e.g. multiple
    // tabs), same reasoning as admin-summary's shared key.
    const cacheKey = `my_summary_stream:${customerId}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    logger.info(`🟢 My-vehicles SSE connected → user=${req.user.email}`);

    const lastSent = new Map();
    // Same vehicle-set-change tracking as admin-summary/stream above.
    let knownIds = null;

    const fetchMyRows = async () => {
      const result = await db.query(`
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_reg_no,
          vm.date_of_deployment::text AS date_of_deployment,
          vt.make                     AS vehicle_make,
          vt.model                    AS vehicle_model,
          vt.capacity_tonne           AS capacity,
          vm.vcu_make_model,
          vm.hmi_make_model,
          vls.last_seen,
          CASE
            WHEN vls.total_running_hrs IS NOT NULL
            THEN ROUND(EXTRACT(EPOCH FROM vls.total_running_hrs) / 3600.0, 2)
            ELSE NULL
          END                         AS total_hours,
          ROUND(vls.total_kwh_consumed, 2) AS total_kwh,
          ROUND(vls.avg_kwh, 2)            AS avg_kwh
        FROM vehicle_master vm
        JOIN vehicle_type_master vt ON vm.vtype_id = vt.vtype_id
        LEFT JOIN vehicle_latest_snapshot vls
          ON vls.vehicle_master_id = vm.vehicle_master_id
        WHERE vm.customer_id = $1
        ORDER BY vm.vehicle_master_id ASC
      `, [customerId]);
      return result.rows;
    };

    const poll = async () => {
      if (res.writableEnded) return;

      try {
        cleanupLiveCache();
        const now = Date.now();
        const entry = liveCache.get(cacheKey);

        let rows;
        if (entry?.data && now - entry.ts < SUMMARY_POLL_INTERVAL_MS) {
          rows = entry.data;
        } else if (entry?.inflight) {
          rows = await entry.inflight;
        } else {
          const inflight = fetchMyRows();
          liveCache.set(cacheKey, { ts: now, inflight });
          rows = await inflight;
          liveCache.set(cacheKey, { ts: Date.now(), data: rows });
        }

        const currentIds = new Set(rows.map((r) => r.vehicle_master_id));
        if (knownIds !== null) {
          const changed =
            currentIds.size !== knownIds.size ||
            [...currentIds].some((id) => !knownIds.has(id));
          if (changed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: 'refetch' })}\n\n`);
          }
        }
        knownIds = currentIds;

        for (const row of rows) {
          const lastSeenIso = row.last_seen ? new Date(row.last_seen).toISOString() : null;
          // See the identical comment in /admin-summary/stream above — status
          // must be in the fingerprint or an online -> offline transition
          // with no new telemetry never reaches the client.
          const status = getVehicleStatus(row.last_seen);
          const fingerprint = `${lastSeenIso}|${row.total_hours}|${row.total_kwh}|${row.avg_kwh}|${status}`;

          if (lastSent.get(row.vehicle_master_id) === fingerprint) continue;
          lastSent.set(row.vehicle_master_id, fingerprint);

          const payload = {
            vehicle_master_id:  row.vehicle_master_id,
            vehicle_reg_no:     row.vehicle_reg_no    || '—',
            vehicle_make:       row.vehicle_make       || '',
            vehicle_model:      row.vehicle_model      || '',
            capacity:           row.capacity           ?? '—',
            vcu_make_model:     row.vcu_make_model,
            hmi_make_model:     row.hmi_make_model,
            date_of_deployment: row.date_of_deployment,
            total_hours:        row.total_hours,
            total_kwh:          row.total_kwh,
            avg_kwh:            row.avg_kwh,
            status,
            last_seen:          row.last_seen,
          };

          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          }
        }
      } catch (err) {
        logger.error(`My-vehicles SSE poll error: ${err.message}`);
      }
    };

    await poll();

    const interval = setInterval(poll, SUMMARY_POLL_INTERVAL_MS);

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
      // Deliberately not liveCache.delete(cacheKey) — shared across every
      // open connection for this customer.
      logger.info(`🔴 My-vehicles SSE disconnected → user=${req.user.email}`);
    });
  }
);

/* ============================================================
   3. GET /api/vehicle-master — Admin full detailed list
   Correlated subqueries replaced with LEFT JOINs to avoid
   2×N extra queries for a fleet of N vehicles.
============================================================ */
router.get(
  '/',
  authenticateToken,
  checkPermission('vehicle_master', 'read'),
  async (req, res) => {
    // Defense in depth — same reasoning as /admin-summary above. This
    // route leaks even more (hardware serials, IMEI numbers, full config)
    // across every customer, with no scoping of its own.
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const result = await db.query(`
        SELECT
          vm.vehicle_master_id,
          vm.vehicle_unique_id,
          vm.vehicle_reg_no,
          vm.customer_id,
          vm.vtype_id,

          vcu.serial_number AS vcu_serial,
          hmi.imei_number   AS hmi_imei,

          vm.vcu_make_model,
          vm.hmi_make_model,
          vm.motor_unique_id,
          vm.motor_make_model,
          vm.controller_unique_id,
          vm.controller_make_model,
          vm.battery_unique_id,
          vm.battery_make_model,
          vm.dc_dc_make_model,
          vm.btms_make_model,

          vm.hyd_cooling_yesno,
          vm.motor_controller_details,
          vm.compressor_yesno,
          vm.compressor_details,
          vm.motor_cooling_yesno,
          vm.motor_cooling_details,

          vm.date_of_deployment::text AS date_of_deployment,

          vt.make         AS vehicle_make,
          vt.model        AS vehicle_model,
          cm.company_name,

          -- LEFT JOINs replace the original correlated subqueries,
          -- eliminating 2×N extra round-trips for a fleet of N vehicles
          vcu_vm.vehicle_unique_id AS vcu_assigned_to,
          hmi_vm.vehicle_unique_id AS hmi_assigned_to

        FROM vehicle_master vm
        JOIN vehicle_type_master vt ON vm.vtype_id    = vt.vtype_id
        JOIN customer_master cm     ON vm.customer_id = cm.customer_id
        LEFT JOIN vcu_master vcu    ON vm.vcu_id      = vcu.vcu_id
        LEFT JOIN hmi_master hmi    ON vm.hmi_id      = hmi.hmi_id
        -- Which other vehicle (if any) shares this VCU?
        LEFT JOIN vehicle_master vcu_vm
          ON  vcu_vm.vcu_id            = vm.vcu_id
          AND vcu_vm.vehicle_master_id != vm.vehicle_master_id
        -- Which other vehicle (if any) shares this HMI?
        LEFT JOIN vehicle_master hmi_vm
          ON  hmi_vm.hmi_id            = vm.hmi_id
          AND hmi_vm.vehicle_master_id != vm.vehicle_master_id

        ORDER BY vm.vehicle_master_id DESC
      `);

      res.json(result.rows);
    } catch (err) {
      logger.error('GET /vehicle-master error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   4. POST /api/vehicle-master — Create a new vehicle
   FIX: specific constraint checks now come BEFORE the generic
   23505 fallback (they were previously unreachable).
============================================================ */
router.post(
  '/',
  authenticateToken,
  checkPermission('vehicle_master', 'write'),
  async (req, res) => {
    const {
      vehicle_unique_id,
      customer_id,
      vtype_id,
      vcu_id,
      hmi_id,
      vehicle_reg_no,
      vcu_make_model,
      hmi_make_model,
      motor_unique_id,
      motor_make_model,
      controller_unique_id,
      controller_make_model,
      battery_unique_id,
      battery_make_model,
      dc_dc_make_model,
      btms_make_model,
      hyd_cooling_yesno,
      motor_controller_details,
      compressor_yesno,
      compressor_details,
      motor_cooling_yesno,
      motor_cooling_details,
      date_of_deployment,
    } = req.body;

    if (!vehicle_unique_id || !customer_id || !vtype_id) {
      return res.status(400).json({
        error: 'Missing required fields: unique ID, customer, or vehicle type',
      });
    }

    try {
      const result = await db.query(`
        INSERT INTO vehicle_master (
          vehicle_unique_id, customer_id, vtype_id,
          vcu_id, hmi_id, vehicle_reg_no,
          vcu_make_model, hmi_make_model,
          motor_unique_id, motor_make_model,
          controller_unique_id, controller_make_model,
          battery_unique_id, battery_make_model,
          dc_dc_make_model, btms_make_model,
          hyd_cooling_yesno, motor_controller_details,
          compressor_yesno, compressor_details,
          motor_cooling_yesno, motor_cooling_details,
          date_of_deployment,
          created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24
        )
        RETURNING vehicle_master_id
      `, [
        vehicle_unique_id, customer_id, vtype_id,
        vcu_id   || null,  hmi_id  || null,  vehicle_reg_no  || null,
        vcu_make_model     || null,  hmi_make_model     || null,
        motor_unique_id    || null,  motor_make_model    || null,
        controller_unique_id || null, controller_make_model || null,
        battery_unique_id  || null,  battery_make_model  || null,
        dc_dc_make_model   || null,  btms_make_model     || null,
        hyd_cooling_yesno     ?? false,
        motor_controller_details || null,
        compressor_yesno      ?? false,
        compressor_details     || null,
        motor_cooling_yesno   ?? false,
        motor_cooling_details  || null,
        date_of_deployment     || null,
        req.user.user_id,
      ]);

      res.status(201).json({ id: result.rows[0].vehicle_master_id });
    } catch (err) {
      logger.error('POST /vehicle-master error:', err.message);

      if (err.code === '23505') {
        // Check specific constraints first — the original code had these
        // AFTER the generic check, making them permanently unreachable.
        if (err.constraint === 'vehicle_master_vcu_id_unique') {
          return res.status(409).json({ error: 'This VCU is already assigned to another vehicle' });
        }
        if (err.constraint === 'vehicle_master_hmi_id_unique') {
          return res.status(409).json({ error: 'This HMI is already assigned to another vehicle' });
        }
        return res.status(409).json({ error: 'Vehicle Unique ID already exists' });
      }

      res.status(500).json({ error: 'Failed to create vehicle' });
    }
  }
);

/* ============================================================
   5. PUT /api/vehicle-master/:id — Update a vehicle
============================================================ */
router.put(
  '/:id',
  authenticateToken,
  checkPermission('vehicle_master', 'write'),
  async (req, res) => {
    const allowedFields = [
      'vehicle_reg_no', 'customer_id', 'vtype_id', 'vcu_id', 'hmi_id',
      'vcu_make_model', 'hmi_make_model',
      'motor_unique_id', 'motor_make_model',
      'controller_unique_id', 'controller_make_model',
      'battery_unique_id', 'battery_make_model',
      'dc_dc_make_model', 'btms_make_model',
      'hyd_cooling_yesno', 'motor_controller_details',
      'compressor_yesno', 'compressor_details',
      'motor_cooling_yesno', 'motor_cooling_details',
      'date_of_deployment',
    ];

    const updates = [];
    const values  = [];
    let   index   = 1;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${index}`);
        values.push(req.body[field]);
        index++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' });
    }

    values.push(req.params.id);

    try {
      const result = await db.query(`
        UPDATE vehicle_master
        SET ${updates.join(', ')}, updated_at = NOW()
        WHERE vehicle_master_id = $${index}
        RETURNING vehicle_master_id
      `, values);

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error('PUT /vehicle-master/:id error:', err.message);
      if (err.code === '23505') {
        if (err.constraint === 'vehicle_master_vcu_id_unique') {
          return res.status(409).json({ error: 'This VCU is already assigned to another vehicle' });
        }
        if (err.constraint === 'vehicle_master_hmi_id_unique') {
          return res.status(409).json({ error: 'This HMI is already assigned to another vehicle' });
        }
        return res.status(409).json({ error: 'Unique constraint violated (possibly unique ID)' });
      }
      res.status(500).json({ error: 'Update failed' });
    }
  }
);

/* ============================================================
   6. DELETE /api/vehicle-master/:id
   NOTE: live_values has ON DELETE CASCADE so Postgres will
   automatically remove child rows if this delete proceeds.
   The liveCheck guard below is intentional business logic:
   we never hard-delete a vehicle that has telemetry history.
   Remove this guard only if soft-delete / archiving is
   implemented as a replacement.
============================================================ */
router.delete(
  '/:id',
  authenticateToken,
  checkPermission('vehicle_master', 'delete'),
  async (req, res) => {
    try {
      const liveCheck = await db.query(
        `SELECT 1 FROM live_values WHERE vehicle_master_id = $1 LIMIT 1`,
        [req.params.id]
      );

      if (liveCheck.rows.length > 0) {
        return res.status(400).json({
          error: 'Cannot delete: vehicle has live/telemetry data',
        });
      }

      const result = await db.query(
        `
        DELETE FROM vehicle_master
        WHERE vehicle_master_id = $1
        RETURNING vehicle_master_id
        `,
        [req.params.id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error('DELETE /vehicle-master/:id error:', err.message);
      res.status(500).json({ error: 'Delete failed' });
    }
  }
);

module.exports = router;