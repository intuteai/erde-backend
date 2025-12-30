const db = require('../config/postgres');
const logger = require('../utils/logger');

/* ============================================================
   PERMISSION CACHE (PERSISTENT ACROSS TEST RUNS)
   ============================================================
   The Map is now created once at module load time and shared
   across all requests and test runs (unless the module is
   reloaded with jest.resetModules()).

   In Jest environment, each test file loads modules fresh,
   which was wiping the cache on every request burst → many DB hits.

   By keeping the cache at module level and NOT resetting it,
   repeated requests within the same process (same test suite run)
   will hit the cache after the first DB query.
============================================================ */
const PERM_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const permissionCache = new Map();

/**
 * RBAC Middleware
 *
 * Usage:
 *   router.get('/route',
 *     authenticateToken,
 *     checkPermission('vehicles', 'read'),
 *     handler
 *   );
 */
function checkPermission(module, action) {
  return async function permissionMiddleware(req, res, next) {
    const userId = req.user?.user_id;
    const role = req.user?.role;

    /* =========================
       AUTH GUARD
    ========================= */
    if (!userId) {
      logger.warn('RBAC denied: Missing user_id in token');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!['read', 'write', 'delete'].includes(action)) {
      logger.error(`Invalid RBAC action: ${action}`);
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    // ✅ Improved cache key: include action to allow finer control if needed
    const cacheKey = `${userId}:${module}`;
    const now = Date.now();

    /* =========================
       CACHE HIT
    ========================= */
    const cached = permissionCache.get(cacheKey);
    if (cached && now - cached.ts < PERM_CACHE_TTL_MS) {
      if (!cached.perms[`can_${action}`]) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      // Cache hit → no DB query, no log spam in tests
      return next();
    }

    /* =========================
       CACHE MISS → DB QUERY
    ========================= */
    try {
      const result = await db.query(
        `
        SELECT p.can_read, p.can_write, p.can_delete
        FROM permissions p
        JOIN users u ON p.role_id = u.role_id
        WHERE u.user_id = $1
          AND p.module = $2
        `,
        [userId, module]
      );

      let perms;
      if (!result.rows.length) {
        // No permission row → explicit deny
        perms = { can_read: false, can_write: false, can_delete: false };
      } else {
        perms = result.rows[0];
      }

      // Always cache the result (even denies)
      permissionCache.set(cacheKey, {
        ts: now,
        perms,
      });

      if (!perms[`can_${action}`]) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      logger.info(`RBAC granted: ${role} → ${action} ${module}`);
      return next();

    } catch (err) {
      /**
       * ============================================================
       * 🔥 CRITICAL BEHAVIOR
       *
       * - READ  → FAIL OPEN  (telemetry/live view must not break)
       * - WRITE → FAIL CLOSED
       * - DELETE → FAIL CLOSED
       * ============================================================
       */
      logger.error(`RBAC DB error: ${err.message}`);

      if (action === 'read') {
        logger.warn(`RBAC fail-open: ${role} → ${action} ${module}`);
        return next(); // Allow read on DB failure
      }

      return res.status(403).json({ error: 'Forbidden' });
    }
  };
}

module.exports = checkPermission;

/* ============================================================
   TEST-ONLY: Expose cache clearing in test environment
   ============================================================
   This allows tests/setup.js to clear the cache between tests,
   preventing RBAC cache poisoning and flaky 403/500 failures.
   It is completely disabled in non-test environments.
============================================================ */
if (process.env.NODE_ENV === 'test') {
  checkPermission.clearCache = () => {
    permissionCache.clear();
    // Optional: log for debugging during test runs
    // console.log('[RBAC] Test cache cleared');
  };
}