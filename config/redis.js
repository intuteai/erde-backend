const { createClient } = require('redis');
const logger = require('../utils/logger');

const client = createClient({
  url: process.env.REDIS_URL,
});

client.on('error', (err) => logger.error('Redis Client Error:', err.message));

client.connect().then(() => logger.info('Connected to Redis'));

client.delPattern = async (pattern) => {
  const keys = await client.keys(pattern);
  if (keys.length) {
    await client.del(keys);
  }
};

module.exports = client;