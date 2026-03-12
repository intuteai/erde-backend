// routes/telemetry.js
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { insertTelemetryItems } = require('../services/telemetryService');
const logger = require('../utils/logger');

const MAX_BATCH_SIZE = 500;

/* ============================================================
   POST /api/telemetry
   Accepts a JSON body: { items: TelemetryItem[] }
   Authenticated via x-api-key header (timing-safe comparison).
============================================================ */
router.post('/', async (req, res) => {
  try {
    // --- Timing-safe API key comparison ---
    // A plain !== comparison leaks key length via timing side-channel.
    // crypto.timingSafeEqual prevents that.
    const apiKey     = req.headers['x-api-key'] || '';
    const expectedKey = process.env.TELEMETRY_API_KEY || '';

    let isValid = false;
    try {
      isValid =
        apiKey.length > 0 &&
        apiKey.length === expectedKey.length &&
        crypto.timingSafeEqual(
          Buffer.from(apiKey),
          Buffer.from(expectedKey)
        );
    } catch {
      isValid = false;
    }

    if (!isValid) {
      logger.warn(`Unauthorized /api/telemetry access from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // --- Validate payload ---
    const items = req.body.items;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty items array' });
    }

    if (items.length > MAX_BATCH_SIZE) {
      return res.status(400).json({
        error:    `Batch too large. Maximum is ${MAX_BATCH_SIZE} items per request`,
        received: items.length,
      });
    }

    logger.info(`[/api/telemetry] Received ${items.length} items from ${req.ip}`);

    const { inserted } = await insertTelemetryItems(items);

    res.json({ ok: true, inserted });
  } catch (err) {
    logger.error('[/api/telemetry] Error:', err.message, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;