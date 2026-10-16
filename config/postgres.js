const fs = require('fs');
const { Pool } = require('pg');
const logger = require('../utils/logger');
require('dotenv').config();

const isTest = process.env.NODE_ENV === 'test';

// Longest a transaction may sit idle (e.g. '5min', '300s'). Longest legitimate idle gap
// today is an export waiting on a slow browser between 1–5k-row chunks: seconds, not minutes.
const IDLE_IN_TX_TIMEOUT = process.env.DB_IDLE_IN_TX_TIMEOUT || '5min';

const ssl = process.env.DB_SSL_CA
  ? { rejectUnauthorized: true, ca: fs.readFileSync(process.env.DB_SSL_CA) }
  : { rejectUnauthorized: false };

let pool; // SINGLETON

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,

      // ✅ SAFE LIMITS (Aiven + Jest friendly)
      max: isTest ? 8 : 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,

      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    pool.on('connect', (client) => {
      if (!isTest) {
        logger.info('Connected to PostgreSQL');
      }
      // pg only listens for 'error' on IDLE clients. If the server drops a checked-out
      // connection (idle-tx timeout below, pg_terminate_backend, DB restart, network),
      // the event would otherwise be unhandled and crash the whole process. The caller's
      // pending/next query still rejects, so its catch → ROLLBACK → release(true) runs.
      client.on('error', (err) => {
        logger.warn(`PostgreSQL connection dropped while in use: ${err.message}`);
      });
      // Safety net: Postgres ends any transaction left idle longer than this, so a
      // hung request can never hold locks on live_values for hours (incident 2026-10-16).
      // Queued before the caller's first query on this connection.
      client
        .query(`SELECT set_config('idle_in_transaction_session_timeout', $1, false)`, [IDLE_IN_TX_TIMEOUT])
        .catch((err) => logger.error(`Failed to set idle_in_transaction_session_timeout: ${err.message}`));
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
