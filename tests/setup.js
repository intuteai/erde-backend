// tests/setup.js

const db = require('../config/postgres');
const checkPermission = require('../middleware/checkPermission');

beforeEach(() => {
  console.log('[TEST SETUP] Clearing RBAC permission cache...');
  
  if (typeof checkPermission.clearCache === 'function') {
    checkPermission.clearCache();
    console.log('[TEST SETUP] RBAC cache cleared successfully');
  } else {
    console.warn('[TEST SETUP] WARNING: clearCache function not found on checkPermission');
  }
});

afterAll(async () => {
  try {
    await db.closePool();
  } catch (err) {
    console.warn('Warning: Error closing DB pool:', err);
  }
});