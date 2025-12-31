// tests/setup.js

const db = require('../config/postgres');
const checkPermission = require('../middleware/checkPermission');
const rateLimiter = require('../middleware/rateLimiter'); // Add this

// Optional: Global higher timeout for all tests (recommended)
jest.setTimeout(30000); // 30 seconds instead of default 5s

beforeEach(() => {
  console.log('[TEST SETUP] Clearing caches before each test...');

  // Clear RBAC permission cache
  if (typeof checkPermission.clearCache === 'function') {
    checkPermission.clearCache();
    console.log('[TEST SETUP] RBAC cache cleared');
  } else {
    console.warn('[TEST SETUP] clearCache not available on checkPermission');
  }

  // Clear rate limiter buckets (in-memory Map)
  if (typeof rateLimiter._resetAllBuckets === 'function') {
    rateLimiter._resetAllBuckets();
    console.log('[TEST SETUP] Rate limiter buckets cleared');
  }

  // If you have other in-memory caches (e.g., live data cache), clear them here too
  // Example:
  // if (typeof someCache.clear === 'function') someCache.clear();
});

afterAll(async () => {
  console.log('[TEST TEARDOWN] Closing resources...');

  // Forcefully terminate ALL connections in the pg pool
  if (db.$pool && typeof db.$pool.end === 'function') {
    try {
      await db.$pool.end();
      console.log('✅ PostgreSQL pool terminated successfully');
    } catch (err) {
      console.error('❌ Failed to terminate DB pool:', err.message);
    }
  } else if (db.pool && typeof db.pool.end === 'function') {
    // Some configs expose .pool instead of .$pool
    try {
      await db.pool.end();
      console.log('✅ PostgreSQL pool terminated (via .pool)');
    } catch (err) {
      console.error('❌ Failed to terminate DB pool (.pool):', err.message);
    }
  } else {
    console.warn('⚠️  No valid pool found to close on db object');
  }

  // Optional: Give Node a moment to flush
  await new Promise(resolve => setTimeout(resolve, 100));
}, 10000); // Give afterAll up to 10 seconds