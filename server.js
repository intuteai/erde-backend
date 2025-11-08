// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const db = require('./config/postgres');
const { parseCanDataWithDB } = require('./services/dbParser');
const logger = require('./utils/logger');

// === ROUTES ===
const authRoutes = require('./routes/auth');
const vehicleRoutes = require('./routes/vehicle');
const batteryRoutes = require('./routes/battery');
const motorRoutes = require('./routes/motor');
const faultsRoutes = require('./routes/faults');
const configRoutes = require('./routes/config');
const vehicleTypeRoutes = require('./routes/vehicleType');
const vcuHmiRoutes = require('./routes/vcuHmi');
const customerRoutes = require('./routes/customer');
const vehicleMasterRoutes = require('./routes/vehicle-master');
const telemetryRoutes = require('./routes/telemetry'); // ✅ New route

const app = express();
const PORT = process.env.SERVER_PORT || 5000;

// === DYNAMIC CORS ===
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  // Add your production frontend here later
  'http://analytics.erdeenergy.in',
  'https://analytics.erdeenergy.in',
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn(`CORS blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// === API ROUTES ===
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/vehicle-types', vehicleTypeRoutes);
app.use('/api/vcu-hmi', vcuHmiRoutes);
app.use('/api/vehicle-master', vehicleMasterRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/battery', batteryRoutes);
app.use('/api/motor', motorRoutes);
app.use('/api/faults', faultsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/telemetry', telemetryRoutes); // ✅ Added telemetry route

// === HEALTH CHECK ===
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      status: 'OK',
      db: 'connected',
      timestamp: new Date().toISOString(),
      uptime: process.uptime().toFixed(2) + 's',
    });
  } catch {
    res.status(500).json({ status: 'ERROR', db: 'disconnected' });
  }
});

// === 404 HANDLER ===
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// === GLOBAL ERROR HANDLER ===
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// === START SERVER ===
const server = app.listen(PORT, () => {
  logger.info(`EV Dashboard Backend LIVE on http://localhost:${PORT}`);
  logger.info(`Telemetry Endpoint: POST /api/telemetry (x-api-key required)`);
  logger.info(`WebSocket: ws://localhost:${PORT}?token=...&device_id=...`);
});

// === WEBSOCKET SERVER ===
const wss = new WebSocket.Server({ server });

const getVehicleMasterId = async (deviceId) => {
  try {
    const res = await db.query(
      'SELECT vehicle_master_id FROM vehicle_master WHERE vehicle_unique_id = $1',
      [deviceId]
    );
    return res.rows[0]?.vehicle_master_id || null;
  } catch (err) {
    logger.error(`DB error in getVehicleMasterId: ${err.message}`);
    return null;
  }
};

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const deviceId = url.searchParams.get('device_id');

  if (!token || !deviceId) {
    ws.close(4001, 'Token and device_id required');
    return;
  }

  let user;
  try {
    user = jwt.verify(token, process.env.JWT_SECRET);
    ws.user = user;
    ws.deviceId = deviceId;
    logger.info(`WS connected: ${user.email} → ${deviceId}`);
  } catch (err) {
    ws.close(4002, 'Invalid token');
    return;
  }

  const vehicleMasterId = await getVehicleMasterId(deviceId);
  if (!vehicleMasterId) {
    ws.close(4004, 'Vehicle not registered');
    return;
  }
  ws.vehicleMasterId = vehicleMasterId;

  ws.on('message', async (msg) => {
    let payloadHex;
    try {
      const data = JSON.parse(msg.toString());
      payloadHex = data.payload || data.can_frame || msg.toString().trim();
    } catch {
      payloadHex = msg.toString().trim();
    }

    payloadHex = payloadHex.replace(/^0x/i, '').trim();
    if (!payloadHex || !/^[0-9A-Fa-f]+$/.test(payloadHex)) {
      logger.warn(`Invalid CAN frame from ${deviceId}: ${payloadHex}`);
      return;
    }

    try {
      const parsed = await parseCanDataWithDB(payloadHex, vehicleMasterId);

      const keys = Object.keys(parsed).filter(k => k !== 'timestamp');
      if (keys.length > 0) {
        const columns = ['vehicle_master_id', 'recorded_at', ...keys].join(', ');
        const placeholders = keys.map((_, i) => `$${i + 3}`).join(', ');
        const values = [vehicleMasterId, new Date(), ...keys.map(k => parsed[k])];

        // ✅ Append-only insert into live_values (NO upsert)
        await db.query(
          `
          INSERT INTO live_values (${columns})
          VALUES ($1, $2, ${placeholders})
          `,
          values
        );
      }

      if (parsed.fault_code) {
        // ✅ Append-only insert into dtc_events (NO upsert)
        await db.query(
          `
          INSERT INTO dtc_events (vehicle_master_id, code, description, recorded_at)
          VALUES ($1, $2, $3, NOW())
          `,
          [vehicleMasterId, parsed.fault_code, parsed.fault_description || 'Unknown']
        );
      }

      const broadcast = {
        ...parsed,
        timestamp: Date.now(),
        deviceId,
        vehicle_master_id: vehicleMasterId,
      };

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.deviceId === deviceId) {
          client.send(JSON.stringify(broadcast));
        }
      });

      logger.info(`CAN → DB → WS: ${deviceId} | ${payloadHex}`);
    } catch (err) {
      logger.error(`Parse error: ${err.message} | Payload: ${payloadHex}`);
    }
  });

  ws.on('close', () => {
    logger.info(`WS disconnected: ${user.email} (${deviceId})`);
  });

  ws.on('error', (err) => logger.error(`WS error: ${err.message}`));
});

// === GRACEFUL SHUTDOWN ===
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received. Shutting down...`);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
