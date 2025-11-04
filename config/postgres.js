// config/postgres.js
const { Pool } = require('pg');
const logger = require('../utils/logger');
require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false  // ← ALWAYS allow self-signed (Aiven)
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  logger.info('Connected to PostgreSQL (Aiven Cloud)');
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', err.message);
});

module.exports = {
  query: async (text, params) => {
    const start = Date.now();
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      logger.info(`Query executed: ${text.substring(0, 50)}... [${duration}ms]`);
      return res;
    } catch (err) {
      logger.error(`Query failed: ${text.substring(0, 50)}...`, err.message);
      throw err;
    }
  },
  getClient: () => pool.connect(),
};