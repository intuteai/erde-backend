const redis = require('redis');
require('dotenv').config();
const logger = require('../utils/logger');

const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
});

// Custom method to delete keys matching a pattern
redisClient.delPattern = async function (pattern) {
    try {
        const keys = await this.keys(pattern);
        if (keys.length > 0) {
            await this.del(...keys);
            logger.info(`Deleted ${keys.length} Redis keys matching pattern: ${pattern}`);
        } else {
            logger.info(`No Redis keys found for pattern: ${pattern}`);
        }
    } catch (err) {
        logger.error(`Error deleting Redis keys for pattern ${pattern}: ${err.message}`, err.stack);
        throw err;
    }
};

// Handle connection
redisClient.connect()
    .then(() => logger.info('Connected to Redis'))
    .catch(err => logger.error('Redis connection error:', err));

// Handle runtime errors
redisClient.on('error', (err) => logger.error('Redis client error:', err));

module.exports = redisClient;