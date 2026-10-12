// raw-can-trial/route.js
// POST /api/telemetry/raw-can/v1: accepts raw CAN batches for the shadow trial.
const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const { validateBatch } = require('./validateBatch');
const { insertBatch } = require('./store');
const logger = require('../utils/logger');
const { logThrottled } = require('./logThrottle');

const router = express.Router();

const MAX_STATS_HEADER = 2000;

/**
 * The app can report its own upload timings and queue state in an
 * x-raw-can-stats header (JSON). Logged at most once per window, with what the
 * server can see of the same batch, so the tablet can be diagnosed from here.
 */
const logClientStats = (req, batch, receivedAtMs) => {
  const header = req.headers['x-raw-can-stats'];
  if (typeof header !== 'string' || !header || header.length > MAX_STATS_HEADER) return;
  let client;
  try {
    client = JSON.parse(header);
  } catch {
    return;
  }
  if (client === null || typeof client !== 'object' || Array.isArray(client)) return;
  logThrottled('client-stats', 'info', '[raw-can] Client stats', {
    client,
    frames: batch.frames.length,
    lastSequence: batch.lastSequence,
    sinceBatchQueuedS: Math.round((receivedAtMs - batch.sentAtMs) / 100) / 10,
    sinceFirstFrameS: Math.round((receivedAtMs - Number(batch.frames[0].receivedAtMs)) / 100) / 10,
  });
};

const keyMatches = (sent, expected) => {
  if (!expected || typeof sent !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

router.post('/v1', async (req, res) => {
  const receivedAtMs = Date.now();

  if (!config.isEnabled()) {
    return res.status(503).json({ error: 'Raw CAN ingestion is disabled' });
  }

  if (!keyMatches(req.headers['x-api-key'], config.apiKey())) {
    logger.warn(`[raw-can] Unauthorized request from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const result = validateBatch(req.body, req.headers);
  if (!result.ok) {
    logger.warn('[raw-can] Batch rejected', { reason: result.reason, ip: req.ip });
    return res.status(400).json({ accepted: false, reason: result.reason });
  }
  const { batch } = result;

  if (!config.allowedPairs().has(`${batch.vehicleMasterId}:${batch.deviceId}`)) {
    logger.warn('[raw-can] Vehicle/device pair not allowed', {
      vehicleMasterId: batch.vehicleMasterId,
      deviceId: batch.deviceId,
    });
    return res.status(403).json({ error: 'Vehicle/device pair not allowed' });
  }

  try {
    const stored = await insertBatch(batch, receivedAtMs);
    logClientStats(req, batch, receivedAtMs);

    const ack = {
      accepted: true,
      batchId: batch.batchId,
      acceptedFrames: stored.acceptedFrames,
      ackSequence: stored.ackSequence,
      serverReceivedAtMs: stored.serverReceivedAtMs,
      status: 'stored',
    };
    if (stored.overlap) ack.overlap = true;

    if (stored.duplicate) {
      return res.status(200).json({ ...ack, duplicate: true });
    }
    return res.status(202).json(ack);
  } catch (err) {
    logger.error('[raw-can] Batch insert failed', {
      batchId: batch.batchId,
      sessionId: batch.sessionId,
      message: err.message,
      code: err.code,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
