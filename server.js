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
const vehicleMasterRoutes = require('./routes/vehicle-master');

const app = express();

// Trust proxy (for HTTPS behind nginx, Cloudflare, etc.)
app.set('trust proxy', 1);

// PORT
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 5000);

// ================================
// CORS CONFIG – ROBUST & SAFE
// ================================
const stripTrailingSlash = s => String(s || '').replace(/\/+$/, '');
const normalizeOrigin = s => stripTrailingSlash(String(s || '').trim()).toLowerCase();

const parseOrigins = (...vals) => {
  const items = [];
  vals.filter(Boolean).forEach(v => {
    String(v)
      .split(',')
      .map(p => normalizeOrigin(p))
      .filter(Boolean)
      .forEach(x => items.push(x));
  });
  return Array.from(new Set(items));
};

const envOrigins = parseOrigins(
  process.env.ALLOWED_ORIGINS,
  process.env.CORS_ALLOWED_ORIGINS,
  process.env.CORS_ORIGIN,
  process.env.FRONTEND_URL,
  process.env.CLIENT_URL,
  process.env.WEB_ORIGIN
);

const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'https://analytics.erdeenergy.in',
  'http://analytics.erdeenergy.in',
].map(normalizeOrigin);

const allowedOriginsRaw = envOrigins.length > 0 ? envOrigins : defaultOrigins;

// Support exact matches and optional “dot-domain” suffix patterns, e.g. ".erdeenergy.in"
const exactSet = new Set(allowedOriginsRaw.filter(o => !o.startsWith('.')));
const dotDomains = allowedOriginsRaw.filter(o => o.startsWith('.')); // like ".erdeenergy.in"
const allowAll = exactSet.has('*');

const originAllowed = (origin) => {
  // Allow requests with no Origin header (curl, Postman, mobile apps)
  if (!origin) return true;

  if (allowAll) return true;

  const o = normalizeOrigin(origin);
  if (exactSet.has(o)) return true;

  try {
    const url = new URL(o);
    const host = url.hostname;
    // allow if any .domain pattern matches
    if (dotDomains.some(d => host === d.slice(1) || host.endsWith(d))) return true;
  } catch (_) {
    // If URL parsing fails, fall through to deny
  }

  return false;
};

const corsOptions = {
  origin(origin, callback) {
    if (originAllowed(origin)) return callback(null, true);
    logger.warn(`CORS blocked origin: ${origin} | Allowed: ${[...exactSet, ...dotDomains].join(', ')}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-Requested-With'],
  optionsSuccessStatus: 204,
};

// Apply CORS (handles preflight automatically)
app.use(cors(corsOptions));

// ================================
// BODY PARSING
// ================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ================================
// API ROUTES
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

// ================================
// TELEMETRY ENDPOINT
// ================================
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

    // Broadcast latest live data to WebSocket clients
    const latestItem = items[items.length - 1];
    const vehicleMasterId = latestItem.vehicleIdOrMasterId;

    if (vehicleMasterId && latestItem.live) {
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
// 404 HANDLER
// ================================
app.use('*', (_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ================================
// GLOBAL ERROR HANDLER
// ================================
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
// WEBSOCKET SERVER
// ================================
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
  // Enforce WS origin parity with HTTP CORS
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    ws.close(4003, 'WS origin not allowed');
    return;
  }

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
    logger.info(`WS connected: ${user.email || 'unknown'} → ${deviceId}`);
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
// GRACEFUL SHUTDOWN
// ================================
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  try { wss.close(); } catch (_) {}
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Force shutdown after 10s');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;