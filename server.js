// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const db = require('./config/postgres');
const { parseCanDataWithDB } = require('./services/dbParser');
const logger = require('./utils/logger');

// === TELEMETRY SERVICE ===
const { insertTelemetryItems } = require('./services/telemetryService');

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

// If you're behind nginx/Cloudflare and terminate TLS there,
// trusting proxy helps Express get correct protocol/IP.
app.set('trust proxy', 1);

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 5000);

// ================================
// CORS (simple, explicit, predictable)
// ================================
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  // Production
  'http://analytics.erdeenergy.in',
  'https://analytics.erdeenergy.in', // <-- FIXED: had a missing colon before
];

// Allow adding more via env as CSV (optional)
if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean).forEach(o => {
    if (!allowedOrigins.includes(o)) allowedOrigins.push(o);
  });
}

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (curl, Postman, mobile SDKs) with no Origin header
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn(`CORS blocked origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// Ensure preflight requests are handled everywhere
app.options('*', cors(corsOptions));

// ================================
// BODY PARSING
// ================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ================================
// API ROUTES
// ================================
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/battery', batteryRoutes);
app.use('/api/motor', motorRoutes);
app.use('/api/faults', faultsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/vehicle-types', vehicleTypeRoutes);
app.use('/api/vcu-hmi', vcuHmiRoutes);
app.use('/api/customers', customerRoutes);
// Keep the original path that your frontend already uses
app.use('/api/vehicles-master', vehicleMasterRoutes);

// ================================
// TELEMETRY ENDPOINT
// ================================
// Receives continuous data and writes to DB. Requires header: x-api-key
app.post('/telemetryFn', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.TELEMETRY_API_KEY) {
      logger.warn(`Unauthorized /telemetryFn access from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const items = req.body.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty items array' });
    }

    logger.info(`[/telemetryFn] Received ${items.length} telemetry items`);
    const { inserted } = await insertTelemetryItems(items);

    // Broadcast latest live data to WebSocket clients (optional convenience)
    const latestItem = items[items.length - 1];
    const vehicleMasterId = latestItem.vehicleIdOrMasterId;

    if (vehicleMasterId && latestItem.live) {
      const broadcast = {
        ...latestItem.live,
        timestamp: latestItem.ts || Date.now(),
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
    logger.error('[/telemetryFn] Error:', err.message, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ================================
// HEALTH CHECK
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

// ================================
/* 404 + GLOBAL ERROR (optional but helpful) */
// ================================
app.use('*', (_req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, _req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ================================
// START HTTP SERVER
// ================================
const server = app.listen(PORT, () => {
  logger.info(`EV Dashboard Backend LIVE on http://localhost:${PORT}`);
  logger.info(`Telemetry Endpoint: POST /telemetryFn (x-api-key required)`);
  logger.info(`WebSocket: ws://localhost:${PORT}?token=...&device_id=...`);
});

// ================================
// WEBSOCKET SERVER (no CORS checks here)
// ================================
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
    logger.info(`WS connected: ${user.email || 'unknown'} → ${deviceId}`);
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
    logger.info(`WS disconnected: ${user?.email || 'unknown'} (${deviceId})`);
  });

  ws.on('error', (err) => logger.error(`WS error: ${err.message}`));
});

// ================================
// GRACEFUL SHUTDOWN
// ================================
process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  try { wss.close(); } catch (_) {}
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info('Interrupted. Stopping...');
  process.exit(0);
});

module.exports = app;