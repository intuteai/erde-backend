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
const createTelemetryRoutes = require('./routes/telemetry'); // ✅ import telemetry route

const app = express();

// If behind a proxy (nginx, load balancer)
app.set('trust proxy', 1);

// Prefer PORT, then SERVER_PORT, then 5000
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 5000);

// ================================
// CORS (env-driven + safe defaults)
// ================================
const parseOrigins = (...vals) =>
  Array.from(
    new Set(
      vals
        .filter(Boolean)
        .flatMap(v => String(v).split(','))
        .map(s => s.trim())
        .filter(Boolean)
    )
  );

const envOrigins = parseOrigins(
  process.env.ALLOWED_ORIGINS,
  process.env.CORS_ALLOWED_ORIGINS,
  process.env.CORS_ORIGIN,
  process.env.FRONTEND_URL,
  process.env.CLIENT_URL,
  process.env.WEB_ORIGIN
);

const defaultOrigins = [
  'http://analytics.erdeenergy.in',
  'https://analytics.erdeenergy.in',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

const allowedOrigins = envOrigins.length ? envOrigins : defaultOrigins;
const allowAll = allowedOrigins.includes('*');

const corsOptions = {
  origin(origin, cb) {
    if (allowAll) return cb(null, true);
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    logger.warn(`CORS blocked origin: ${origin}`);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ================================
// Body parsing
// ================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ================================
// API routes (mounted at /api/*)
// ================================
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

// ✅ Telemetry route (replaces old /telemetryFn)
let wss; // declared here so we can pass it after creation
app.use('/api/telemetry', (req, res, next) => {
  if (!wss) return res.status(503).json({ error: 'WebSocket not initialized' });
  return createTelemetryRoutes(wss)(req, res, next);
});

// ================================
// Health
// ================================
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      status: 'OK',
      db: 'connected',
      timestamp: new Date().toISOString(),
      uptime: `${process.uptime().toFixed(2)}s`,
    });
  } catch {
    res.status(500).json({ status: 'ERROR', db: 'disconnected' });
  }
});

// 404
app.use('*', (_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ================================
// Start HTTP server
// ================================
const server = app.listen(PORT, () => {
  logger.info(`EV Dashboard Backend LIVE on http://localhost:${PORT}`);
  logger.info(`Telemetry Endpoint: POST /api/telemetry (x-api-key required)`);
  logger.info(`WebSocket: ws://localhost:${PORT}?token=...&device_id=...`);
});

// ================================
// WebSocket server
// ================================
wss = new WebSocket.Server({ server });

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
    logger.info(`WS connected: ${user?.email || 'unknown'} → ${deviceId}`);
  } catch {
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

    payloadHex = String(payloadHex).replace(/^0x/i, '').trim();
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

        await db.query(
          `
          INSERT INTO live_values (${columns})
          VALUES ($1, $2, ${placeholders})
          ON CONFLICT (vehicle_master_id) DO UPDATE SET
            ${keys.map(k => `${k} = EXCLUDED.${k}`).join(', ')},
            recorded_at = EXCLUDED.recorded_at
        `,
          values
        );
      }

      if (parsed.fault_code) {
        await db.query(
          `
          INSERT INTO dtc_events (vehicle_master_id, code, description, recorded_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (vehicle_master_id, code, recorded_at) DO NOTHING
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
    logger.info(`WS disconnected: ${user?.email || 'unknown'} (${deviceId})`);
  });

  ws.on('error', (err) => logger.error(`WS error: ${err.message}`));
});

// ================================
// Graceful shutdown
// ================================
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received. Shutting down...`);
  try { wss.close(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
