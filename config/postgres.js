const { Pool } = require('pg');
const logger = require('../utils/logger');
require('dotenv').config();

const isTest = process.env.NODE_ENV === 'test';

let pool; // 🔒 SINGLETON

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },

      // ✅ SAFE LIMITS (Aiven + Jest friendly)
      max: isTest ? 8 : 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,

      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    pool.on('connect', () => {
      if (!isTest) {
        logger.info('Connected to PostgreSQL');
      }
    });

    pool.on('error', (err) => {
      logger.error(`PostgreSQL pool error: ${err.message}`);
    });
  }

  return pool;
}

/* =========================
   QUERY WRAPPER
========================= */
const query = async (text, params) => {
  const p = getPool();
  const start = Date.now();

  try {
    const res = await p.query(text, params);

    if (!isTest) {
      logger.info(
        `Query: ${text.substring(0, 60)}... (${Date.now() - start}ms)`
      );
    }

    return res;
  } catch (err) {
    logger.error(
      `Query failed: ${text.substring(0, 60)}... → ${err.message}`
    );
    throw err;
  }
};

/* =========================
   CLIENT ACCESS (rare use)
========================= */
const getClient = async () => {
  const p = getPool();
  return p.connect();
};

/* =========================
   SAFE SHUTDOWN
========================= */
const closePool = async () => {
  if (pool) {
    logger.info('Closing PostgreSQL pool');
    await pool.end();
    pool = null; // 🔥 IMPORTANT
  }
};

module.exports = {
  query,
  getClient,
  closePool,
};
