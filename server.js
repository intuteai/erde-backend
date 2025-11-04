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
const vehicleMasterRoutes = require('./routes/vehicleMaster');

const app = express();
const PORT = process.env.SERVER_PORT || 5000;

// === DYNAMIC CORS — SUPPORTS VITE (5173), CRA (3000), etc. ===
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  // Add production later: 'https://yourdomain.com'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser clients (Postman, mobile, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// === API ROUTES ===
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/battery', batteryRoutes);
app.use('/api/motor', motorRoutes);
app.use('/api/faults', faultsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/vehicle-types', vehicleTypeRoutes);
app.use('/api/vcu-hmi', vcuHmiRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/vehicles-master', vehicleMasterRoutes);

// === HEALTH CHECK ===
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'OK', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: 'ERROR', db: 'disconnected' });
  }
});

// === START HTTP SERVER ===
const server = app.listen(PORT, () => {
  logger.info(`EV Dashboard Backend LIVE on http://localhost:${PORT}`);
});

// === WEBSOCKET SERVER — REAL CAN INGRESS (NO AWS) ===
const wss = new WebSocket.Server({ server });

// Map device_unique_id → vehicle_master_id
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

  // === VALIDATE ===
  if (!token || !deviceId) {
    ws.close(4001, 'Token and device_id required');
    return;
  }

  // === JWT VERIFY ===
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

  // === GET vehicle_master_id ===
  const vehicleMasterId = await getVehicleMasterId(deviceId);
  if (!vehicleMasterId) {
    ws.close(4004, 'Vehicle not registered');
    return;
  }
  ws.vehicleMasterId = vehicleMasterId;

  // === ON MESSAGE: CAN FRAME FROM VCU ===
  ws.on('message', async (msg) => {
    let payloadHex;
    try {
      const data = JSON.parse(msg.toString());
      payloadHex = data.payload || data.can_frame || msg.toString().trim();
    } catch {
      payloadHex = msg.toString().trim();
    }

    if (!payloadHex || !/^x?[0-9A-Fa-f]+$/.test(payloadHex.replace('x', ''))) {
      logger.warn(`Invalid CAN frame from ${deviceId}: ${payloadHex}`);
      return;
    }

    try {
      const parsed = await parseCanDataWithDB(payloadHex, vehicleMasterId);

      // === UPSERT live_values ===
      const keys = Object.keys(parsed).filter(k => k !== 'timestamp');
      if (keys.length > 0) {
        const columns = ['vehicle_master_id', 'recorded_at', ...keys].join(', ');
        const placeholders = keys.map((_, i) => `$${i + 3}`).join(', ');
        const values = [vehicleMasterId, new Date(), ...keys.map(k => parsed[k])];

        await db.query(`
          INSERT INTO live_values (${columns})
          VALUES ($1, $2, ${placeholders})
          ON CONFLICT (vehicle_master_id) DO UPDATE SET
            ${keys.map(k => `${k} = EXCLUDED.${k}`).join(', ')},
            recorded_at = EXCLUDED.recorded_at
        `, values);
      }

      // === SAVE FAULTS ===
      if (parsed.fault_code) {
        await db.query(`
          INSERT INTO dtc_events (vehicle_master_id, code, description, recorded_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (vehicle_master_id, code, recorded_at) DO NOTHING
        `, [vehicleMasterId, parsed.fault_code, parsed.fault_description || 'Unknown']);
      }

      // === BROADCAST TO ALL CLIENTS ===
      const broadcast = {
        ...parsed,
        timestamp: Date.now(),
        deviceId,
        vehicle_master_id: vehicleMasterId
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
process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  wss.close();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info('Interrupted. Stopping...');
  process.exit(0);
});

module.exports = app;