// raw-can-trial/store.js
// Persists validated raw CAN batches. One row per batch in raw_can_batches.
const db = require('../config/postgres');

/**
 * Inserts a batch unless its batchId is already stored.
 * A batch whose sequence range overlaps another stored batch of the same
 * device and session is still stored, with overlap = true.
 *
 * @param {object} batch         output of validateBatch()
 * @param {number} receivedAtMs  server time the request arrived
 * @returns {Promise<{duplicate: boolean, overlap: boolean, ackSequence: number,
 *                    acceptedFrames: number, serverReceivedAtMs: number}>}
 */
const insertBatch = async (batch, receivedAtMs) => {
  const inserted = await db.query(
    `
    INSERT INTO raw_can_batches (
      batch_id, vehicle_master_id, device_id, session_id,
      first_sequence, last_sequence, frame_count, sent_at_ms,
      server_received_at, overlap, frames
    )
    VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      to_timestamp($9 / 1000.0),
      EXISTS (
        SELECT 1 FROM raw_can_batches
        WHERE device_id = $3
          AND session_id = $4
          AND first_sequence <= $6
          AND last_sequence  >= $5
          AND batch_id <> $1
      ),
      $10::jsonb
    )
    ON CONFLICT (batch_id) DO NOTHING
    RETURNING overlap
    `,
    [
      batch.batchId,
      batch.vehicleMasterId,
      batch.deviceId,
      batch.sessionId,
      batch.firstSequence,
      batch.lastSequence,
      batch.frames.length,
      batch.sentAtMs,
      receivedAtMs,
      JSON.stringify(batch.frames),
    ]
  );

  if (inserted.rows.length) {
    return {
      duplicate: false,
      overlap: inserted.rows[0].overlap,
      ackSequence: batch.lastSequence,
      acceptedFrames: batch.frames.length,
      serverReceivedAtMs: receivedAtMs,
    };
  }

  // Already stored: answer with what was acknowledged the first time.
  const existing = await db.query(
    `
    SELECT last_sequence, frame_count, overlap,
           (EXTRACT(EPOCH FROM server_received_at) * 1000)::bigint AS received_ms
    FROM raw_can_batches
    WHERE batch_id = $1
    `,
    [batch.batchId]
  );
  const row = existing.rows[0];

  return {
    duplicate: true,
    overlap: row.overlap,
    ackSequence: Number(row.last_sequence),
    acceptedFrames: row.frame_count,
    serverReceivedAtMs: Number(row.received_ms),
  };
};

module.exports = { insertBatch };
