const express = require('express');
const router = express.Router();
const { insertTelemetryItems } = require('../services/telemetryService');
const logger = require('../utils/logger');
const WebSocket = require('ws'); // Optional, if you want broadcast inside here

module.exports = (wss) => {
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

      // Optional: broadcast to WebSocket clients
      const latestItem = items[items.length - 1];
      const vehicleMasterId = latestItem.vehicleIdOrMasterId;

      if (vehicleMasterId && latestItem.live && wss) {
        const broadcast = {
          ...latestItem.live,
          timestamp: latestItem.ts,
          deviceId: vehicleMasterId,
          vehicle_master_id: vehicleMasterId,
        };

        wss.clients.forEach(client => {
          if (
            client.readyState === WebSocket.OPEN &&
            String(client.vehicleMasterId) === String(vehicleMasterId)
          ) {
            client.send(JSON.stringify(broadcast));
          }
        });
      }

      res.json({ ok: true, inserted });
    } catch (err) {
      logger.error('[/api/telemetry] Error:', err.message, { stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
