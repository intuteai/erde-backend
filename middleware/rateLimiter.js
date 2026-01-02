/**
 * Rate Limiter Middleware (In-Memory, Memory-Safe, Session-Aware)
 *
 * ✔ Session-scoped limiting (user + device)
 * ✔ Per-endpoint bucket support
 * ✔ Retry-After header
 * ✔ 429 response
 * ✔ Automatic cleanup (no memory leak)
 * ✔ Windows / Jest safe
 * ✔ Fail-open on internal errors
 */

const logger = require('../utils/logger');

/* =========================
   CONFIG
========================= */
const DEFAULT_WINDOW_MS = 60_000;        // 1 minute
const DEFAULT_MAX_REQUESTS = 200;        // ↑ increased
const CLEANUP_INTERVAL_MS = 60_000;

/* =========================
   INTERNAL STORE
========================= */
const buckets = new Map();

/* =========================
   CLEANUP (SINGLE TIMER)
========================= */
function cleanup() {
  const now = Date.now();
  for (const [key, entry] of buckets.entries()) {
    if (entry.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

// Prevent duplicate timers (nodemon / jest / hot reload)
if (!global.__RATE_LIMITER_CLEANUP__) {
  global.__RATE_LIMITER_CLEANUP__ = setInterval(cleanup, CLEANUP_INTERVAL_MS);

  if (typeof global.__RATE_LIMITER_CLEANUP__.unref === 'function') {
    global.__RATE_LIMITER_CLEANUP__.unref();
  }
}

/* =========================
   KEY GENERATOR
========================= */
function buildKey(req, keyPrefix, isTestEnv) {
  // Authenticated users → session scoped
  if (req.user?.user_id) {
    const ua = req.headers['user-agent'] || 'ua';
    const ip = req.ip || 'ip';
    return `${keyPrefix}:user:${req.user.user_id}:${ip}:${ua}`;
  }

  // Test environment (deterministic)
  if (isTestEnv) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return `${keyPrefix}:test:${authHeader.split(' ')[1]}`;
    }
    return `${keyPrefix}:test:unauthenticated`;
  }

  // Public / unauthenticated fallback
  const ua = req.headers['user-agent'] || 'ua';
  const ip = req.ip || 'ip';
  return `${keyPrefix}:public:${ip}:${ua}`;
}

/* =========================
   RATE LIMITER FACTORY
========================= */
function rateLimiter(options = {}) {
  const isTestEnv = process.env.NODE_ENV === 'test';

  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const max = options.max ?? DEFAULT_MAX_REQUESTS;

  const keyPrefix = options.keyPrefix ?? 'global';
  const message = options.message ?? 'Too many requests';
  const statusCode = options.statusCode ?? 429;
  const skipInTest = options.skipInTest === true;

  return function rateLimitMiddleware(req, res, next) {
    if (isTestEnv && skipInTest) {
      return next();
    }

    try {
      const now = Date.now();
      const key = buildKey(req, keyPrefix, isTestEnv);

      let entry = buckets.get(key);

      if (!entry || entry.resetAt <= now) {
        buckets.set(key, {
          count: 1,
          resetAt: now + windowMs,
        });
        return next();
      }

      entry.count += 1;

      if (entry.count > max) {
        const retryAfter = Math.max(
          1,
          Math.ceil((entry.resetAt - now) / 1000)
        );

        res.setHeader('Retry-After', retryAfter);

        logger.warn(
          `Rate limit exceeded: key=${keyPrefix}, count=${entry.count}, max=${max}`
        );

        return res.status(statusCode).json({
          error: message,
          retry_after: retryAfter,
        });
      }

      next();
    } catch (err) {
      logger.error(`Rate limiter internal error: ${err.message}`, err);
      next(); // fail-open
    }
  };
}

/* =========================
   PRECONFIGURED LIMITERS
========================= */
module.exports = {
  rateLimiter,

  // General API (admin dashboards, CRUD)
  generalLimiter: rateLimiter({
    windowMs: 60_000,
    max: 200,               // ↑ increased
    keyPrefix: 'general',
  }),

  // Live telemetry / polling
  liveRateLimiter: rateLimiter({
    windowMs: 60_000,
    max: 300,               // ↑ increased for dashboards
    keyPrefix: 'live',
    message: 'Too many live view requests. Please slow down polling.',
    skipInTest: true,
  }),

  // Auth / sensitive actions
  strictLimiter: rateLimiter({
    windowMs: 15_000,
    max: 10,                // ↑ slightly relaxed
    keyPrefix: 'strict',
  }),
};

/* =========================
   TEST HELPERS
========================= */
if (process.env.NODE_ENV === 'test') {
  module.exports._resetAllBuckets = () => buckets.clear();
}
