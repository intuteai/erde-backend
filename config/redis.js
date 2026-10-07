const { createClient } = require('redis');
const logger = require('../utils/logger');

const client = createClient({
  url: process.env.REDIS_URL,
});

client.on('error', (err) => logger.error('Redis Client Error:', err.message));

// Skip connecting under Jest — nothing in the test suite exercises a
// redis-backed route (only database-logs-export.js and telemetryService.js
// require this module, neither touched by auth.test.js), and a client with
// no reachable REDIS_URL retries forever by design, which is the right
// behavior for a long-running server but leaves a dangling timer that
// stops Jest from exiting once tests finish.
if (process.env.NODE_ENV !== 'test') {
  client.connect().then(() => logger.info('Connected to Redis'));
}

client.delPattern = async (pattern) => {
  const keys = await client.keys(pattern);
  if (keys.length) {
    await client.del(keys);
  }
};

module.exports = client;