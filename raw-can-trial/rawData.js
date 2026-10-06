// raw-can-trial/rawData.js
// Database reads shared by the worker and the report. Read-only.
const db = require('../config/postgres');
const { MAX_FRESH_MS } = require('./freshness');

/** Extra time loaded before a window so state at its start matches the app's. */
const WARMUP_MS = MAX_FRESH_MS + 60_000;
/** Batches can be stored a little after their frames were received. */
const LATE_ARRIVAL_MS = 10 * 60_000;

/**
 * Raw batches for a vehicle whose frames may fall in [fromMs - warm-up, toMs].
 * @returns {Promise<Array<{ batch_id, session_id, first_sequence, last_sequence, frame_count,
 *   sent_at_ms, overlap, server_ms, stored_bytes, frames }>>}
 */
const loadBatches = async (vehicle, fromMs, toMs, { warmup = true } = {}) => {
  const start = fromMs - (warmup ? WARMUP_MS : 0);
  const res = await db.query(
    `
    SELECT batch_id, session_id, first_sequence::float8 AS first_sequence,
           last_sequence::float8 AS last_sequence, frame_count, sent_at_ms::float8 AS sent_at_ms,
           overlap, (EXTRACT(EPOCH FROM server_received_at) * 1000)::float8 AS server_ms,
           pg_column_size(frames) AS stored_bytes, frames
    FROM raw_can_batches
    WHERE vehicle_master_id = $1
      AND server_received_at >= to_timestamp($2 / 1000.0)
      AND server_received_at <= to_timestamp($3 / 1000.0)
    ORDER BY server_received_at, batch_id
    `,
    [vehicle, start, toMs + LATE_ARRIVAL_MS]
  );
  return res.rows;
};

module.exports = { loadBatches, WARMUP_MS };
