// tests/setup.js
// Global Jest setup — runs after test framework is installed.

// Increase timeout for integration tests that hit a real DB
jest.setTimeout(30000);

// Reset rate-limiter buckets before each test suite (describe block)
// so the strictLimiter (10 req / 15s) doesn't fire between suites.
beforeEach(() => {
  const { _resetAllBuckets } = require('../middleware/rateLimiter');
  if (typeof _resetAllBuckets === 'function') {
    _resetAllBuckets();
  }
});
