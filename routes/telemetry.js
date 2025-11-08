const express = require('express');
const router = express.Router();
const { insertTelemetryItems } = require('../services/telemetryService');
const logger = require('../utils/logger');

// POST /api/telemetry
router.post('/', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.TELEMETRY_API_KEY) {
      logger.warn(`Unauthorized /api/telemetry access from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const items = req.body.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty items array' });
    }

    logger.info(`[/api/telemetry] Received ${items.length} telemetry items`);
    const { inserted } = await insertTelemetryItems(items);

    res.json({ ok: true, inserted });
  } catch (err) {
    logger.error('[/api/telemetry] Error:', err.message, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
