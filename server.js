require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { getConfig } = require('./config/config');
const { parseCanData } = require('./services/canParser');
const redisClient = require('./config/redis');
const logger = require('./utils/logger');

// Routes
const authRoutes = require('./routes/auth');
const batteryRoutes = require('./routes/battery');
const motorRoutes = require('./routes/motor');
const faultsRoutes = require('./routes/faults');
const vehicleRoutes = require('./routes/vehicle');
const vehicleHistoricalRoutes = require('./routes/vehicleHistorical');
const configRoutes = require('./routes/config');

const app = express();
const PORT = process.env.SERVER_PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/battery', batteryRoutes);
app.use('/api/motor', motorRoutes);
app.use('/api/faults', faultsRoutes);
app.use('/api/vehicle-historical', vehicleHistoricalRoutes);
app.use('/api/config', configRoutes);

// Start HTTP server
const server = app.listen(PORT, () => {
  logger.info(`✅ EV Dashboard Backend running on port ${PORT} at ${new Date().toString()}`);
});

// WebSocket Server
const wss = new WebSocket.Server({ server });
const awsWsPool = new Map();

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const token = params.get('token');
  const deviceId = params.get('device_id') || 'VCL001';

  if (!token) {
    logger.error(`WebSocket connection failed: Missing token for ${deviceId}`);
    ws.close(4001, 'Authentication token missing');
    return;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
    ws.user = decoded;
    ws.deviceId = deviceId;
    logger.info(`🟢 WebSocket auth success: ${ws.user.username} for ${deviceId}`);
  } catch (err) {
    logger.error(`🔴 WebSocket token invalid for ${deviceId}: ${err.message}`);
    ws.close(4002, 'Invalid or expired token');
    return;
  }

  // Get config (cached)
  const getConfigAsync = async () => {
    const key = `config:${deviceId.toLowerCase()}`;
    let config = await redisClient.get(key);
    if (!config) {
      config = getConfig(deviceId);
      if (config) {
        await redisClient.setEx(key, 3600, JSON.stringify(config));
        logger.info(`Cached config for ${deviceId}`);
      } else {
        logger.error(`No config available for deviceId ${deviceId}`);
        return null;
      }
    } else {
      config = JSON.parse(config);
    }
    return config;
  };

  // AWS WebSocket Setup
  let awsWs = awsWsPool.get(deviceId);
  if (!awsWs || awsWs.readyState === WebSocket.CLOSED || awsWs.readyState === WebSocket.CLOSING) {
    awsWs = new WebSocket(`${process.env.AWS_WS_URL}?device_id=${deviceId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.AWS_API_KEY || ''}`,
      },
    });
    awsWsPool.set(deviceId, awsWs);

    awsWs.on('open', () => {
      const subscriptionMessage = JSON.stringify({ action: 'subscribe', device_id: deviceId });
      awsWs.send(subscriptionMessage);
      logger.info(`AWS WS subscribed for ${deviceId}: ${subscriptionMessage}`);
    });

    awsWs.on('message', async (awsMessage) => {
      try {
        const raw = JSON.parse(awsMessage.toString());
        logger.info(`AWS WS message received for ${deviceId}: ${JSON.stringify(raw)}`);
        const config = await getConfigAsync();
        if (!config) {
          logger.error(`Cannot process WebSocket message: No config for ${deviceId}`);
          return;
        }
        const payload = raw.payload || (raw.items && raw.items[0]?.payload) || raw;
        const parsed = parseCanData(payload, config);
        // Select latest data if arrays
        const latestData = {
          battery: Array.isArray(parsed.battery)
            ? parsed.battery.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || {}
            : parsed.battery || {},
          motor: Array.isArray(parsed.motor)
            ? parsed.motor.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || {}
            : parsed.motor || {},
          faults: Array.isArray(parsed.faults)
            ? parsed.faults.sort((a, b) => (b.faultTimestamp || 0) - (a.faultTimestamp || 0))[0] || {}
            : parsed.faults || {},
          timestamp: parsed.timestamp || Date.now(),
        };
        logger.info(`Sending parsed data to clients for ${deviceId}: ${JSON.stringify(latestData)}`);
        await redisClient.delPattern(`getData:${deviceId}:*`);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.deviceId === deviceId) {
            client.send(JSON.stringify(latestData));
          }
        });
      } catch (err) {
        logger.error(`WS parse error for ${deviceId}: ${err.message}`);
      }
    });

    awsWs.on('close', () => {
      logger.info(`AWS WS closed for ${deviceId}`);
      awsWsPool.delete(deviceId);
    });

    awsWs.on('error', (err) => logger.error(`AWS WS error for ${deviceId}: ${err.message}`));
  }

  ws.on('message', (message) => {
    logger.info(`[${ws.user.username}] → ${message} for ${deviceId}`);
    if (awsWs.readyState === WebSocket.OPEN) awsWs.send(message);
  });

  ws.on('close', () => {
    logger.info(`🔌 WebSocket closed for ${ws.user.username} (${deviceId})`);
    // Only reconnect if there are still clients for this deviceId
    const hasClients = Array.from(wss.clients).some(client => client.deviceId === deviceId && client.readyState === WebSocket.OPEN);
    if (!hasClients) {
      if (awsWs && awsWs.readyState === WebSocket.OPEN) {
        awsWs.close();
        awsWsPool.delete(deviceId);
        logger.info(`Closed AWS WS for ${deviceId} due to no active clients`);
      }
    }
  });

  ws.on('error', (err) => logger.error(`Client WS error for ${deviceId}: ${err.message}`));
});

// Reconnect function
function connectWebSocket(deviceId) {
  // Only reconnect if there are active clients for this deviceId
  const hasClients = Array.from(wss.clients).some(client => client.deviceId === deviceId && client.readyState === WebSocket.OPEN);
  if (!hasClients) {
    logger.info(`No active clients for ${deviceId}, skipping WebSocket reconnect`);
    return;
  }

  let awsWs = awsWsPool.get(deviceId);
  if (!awsWs || awsWs.readyState === WebSocket.CLOSED || awsWs.readyState === WebSocket.CLOSING) {
    awsWs = new WebSocket(`${process.env.AWS_WS_URL}?device_id=${deviceId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.AWS_API_KEY || ''}`,
      },
    });
    awsWsPool.set(deviceId, awsWs);

    awsWs.on('open', () => {
      const subscriptionMessage = JSON.stringify({ action: 'subscribe', device_id: deviceId });
      awsWs.send(subscriptionMessage);
      logger.info(`AWS WS re-subscribed for ${deviceId}: ${subscriptionMessage}`);
    });

    awsWs.on('message', async (awsMessage) => {
      try {
        const raw = JSON.parse(awsMessage.toString());
        logger.info(`AWS WS message received for ${deviceId}: ${JSON.stringify(raw)}`);
        const config = await getConfigAsync();
        if (!config) {
          logger.error(`Cannot process WebSocket message: No config for ${deviceId}`);
          return;
        }
        const payload = raw.payload || (raw.items && raw.items[0]?.payload) || raw;
        const parsed = parseCanData(payload, config);
        // Select latest data if arrays
        const latestData = {
          battery: Array.isArray(parsed.battery)
            ? parsed.battery.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || {}
            : parsed.battery || {},
          motor: Array.isArray(parsed.motor)
            ? parsed.motor.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || {}
            : parsed.motor || {},
          faults: Array.isArray(parsed.faults)
            ? parsed.faults.sort((a, b) => (b.faultTimestamp || 0) - (a.faultTimestamp || 0))[0] || {}
            : parsed.faults || {},
          timestamp: parsed.timestamp || Date.now(),
        };
        logger.info(`Sending parsed data to clients for ${deviceId}: ${JSON.stringify(latestData)}`);
        await redisClient.delPattern(`getData:${deviceId}:*`);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.deviceId === deviceId) {
            client.send(JSON.stringify(latestData));
          }
        });
      } catch (err) {
        logger.error(`WS parse error for ${deviceId}: ${err.message}`);
      }
    });

    awsWs.on('close', () => {
      logger.info(`AWS WS closed for ${deviceId}`);
      awsWsPool.delete(deviceId);
      setTimeout(() => connectWebSocket(deviceId), 5000);
    });

    awsWs.on('error', (err) => logger.error(`AWS WS error for ${deviceId}: ${err.message}`));
  }
}

// Graceful Shutdown
let isSigtermRegistered = false;
if (!isSigtermRegistered) {
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    wss.close(() => logger.info('WSS closed'));
    awsWsPool.forEach(ws => ws.close());
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  });
  isSigtermRegistered = true;
}
