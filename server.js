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
    logger.error('🔴 WebSocket token invalid:', err.message);
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
  if (!awsWs || awsWs.readyState === WebSocket.CLOSED) {
    awsWs = new WebSocket(`${process.env.AWS_WS_URL}?device_id=${deviceId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.AWS_API_KEY || ''}`,
      },
    });
    awsWsPool.set(deviceId, awsWs);

    awsWs.on('open', () => {
      awsWs.send(JSON.stringify({ action: 'subscribe', device_id: deviceId }));
      logger.info(`AWS WS subscribed for ${deviceId}`);
    });

    awsWs.on('message', async (awsMessage) => {
      try {
        const raw = JSON.parse(awsMessage.toString());
        const config = await getConfigAsync();
        if (!config) {
          logger.error(`Cannot process WebSocket message: No config for ${deviceId}`);
          return;
        }
        const payload = raw.payload || (raw.items && raw.items[0]?.payload) || raw;
        const parsed = parseCanData(payload, config);
        await redisClient.delPattern(`getData:${deviceId}:*`);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.deviceId === deviceId) {
            client.send(JSON.stringify({
              battery: parsed.battery,
              motor: parsed.motor,
              faults: parsed.faults,
              timestamp: parsed.timestamp,
            }));
          }
        });
      } catch (err) {
        logger.error(`WS parse error for ${deviceId}:`, err.message);
      }
    });

    awsWs.on('close', () => {
      logger.info(`AWS WS closed for ${deviceId}`);
      awsWsPool.delete(deviceId);
      setTimeout(() => {
        if (wss.clients.size > 0) connectWebSocket(deviceId);
      }, 5000);
    });

    awsWs.on('error', (err) => logger.error(`AWS WS error for ${deviceId}:`, err.message));
  }

  ws.on('message', (message) => {
    logger.info(`[${ws.user.username}] → ${message} for ${deviceId}`);
    if (awsWs.readyState === WebSocket.OPEN) awsWs.send(message);
  });

  ws.on('close', () => logger.info(`🔌 WebSocket closed for ${ws.user.username} (${deviceId})`));

  ws.on('error', (err) => logger.error(`Client WS error for ${deviceId}:`, err.message));
});

// Reconnect function
function connectWebSocket(deviceId) {
  let awsWs = awsWsPool.get(deviceId);
  if (!awsWs || awsWs.readyState === WebSocket.CLOSED) {
    awsWs = new WebSocket(`${process.env.AWS_WS_URL}?device_id=${deviceId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.AWS_API_KEY || ''}`,
      },
    });
    awsWsPool.set(deviceId, awsWs);

    awsWs.on('open', () => {
      awsWs.send(JSON.stringify({ action: 'subscribe', device_id: deviceId }));
      logger.info(`AWS WS re-subscribed for ${deviceId}`);
    });

    awsWs.on('message', async (awsMessage) => {
      try {
        const raw = JSON.parse(awsMessage.toString());
        const config = await getConfigAsync();
        if (!config) {
          logger.error(`Cannot process WebSocket message: No config for ${deviceId}`);
          return;
        }
        const payload = raw.payload || (raw.items && raw.items[0]?.payload) || raw;
        const parsed = parseCanData(payload, config);
        await redisClient.delPattern(`getData:${deviceId}:*`);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.deviceId === deviceId) {
            client.send(JSON.stringify({
              battery: parsed.battery,
              motor: parsed.motor,
              faults: parsed.faults,
              timestamp: parsed.timestamp,
            }));
          }
        });
      } catch (err) {
        logger.error(`WS parse error for ${deviceId}:`, err.message);
      }
    });

    awsWs.on('close', () => {
      logger.info(`AWS WS closed for ${deviceId}`);
      awsWsPool.delete(deviceId);
      setTimeout(() => {
        if (wss.clients.size > 0) connectWebSocket(deviceId);
      }, 5000);
    });

    awsWs.on('error', (err) => logger.error(`AWS WS error for ${deviceId}:`, err.message));
  }
}

// Graceful Shutdown (Register once)
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