require('dotenv').config();
const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');

/* ROUTES */
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customer');
const vehicleTypeRoutes = require('./routes/vehicleType');
const vehicleCategoryRoutes = require('./routes/vehicleCategory');
const vehicleMasterRoutes = require('./routes/vehicle-master');
const vehicleRoutes = require('./routes/vehicle');
const batteryRoutes = require('./routes/battery');
const motorRoutes = require('./routes/motor');
const faultsRoutes = require('./routes/faults');
const configRoutes = require('./routes/config');
const telemetryRoutes = require('./routes/telemetry');
const databaseLogsRoutes = require('./routes/databaseLogs');
const vcuRoutes = require('./routes/vcu');
const hmiRoutes = require('./routes/hmi');

/* RATE LIMITERS */
const { generalLimiter } = require('./middleware/rateLimiter');
// Note: liveRateLimiter should be applied only on specific live endpoints (e.g. in telemetryRoutes)

const app = express();

/* =========================
   CORS
========================= */
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
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
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   PUBLIC ROUTES (NO RATE LIMIT)
========================= */
// Auth routes – must NOT be rate-limited globally for reliable tests
app.use('/api/auth', authRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

/* =========================
   PROTECTED API ROUTES (WITH GENERAL RATE LIMIT)
========================= */
// Apply general rate limiting to all protected endpoints
app.use('/api/customers', generalLimiter, customerRoutes);
app.use('/api/vehicle-types', generalLimiter, vehicleTypeRoutes);
app.use('/api/vehicle-categories', generalLimiter, vehicleCategoryRoutes);
app.use('/api/vehicle-master', generalLimiter, vehicleMasterRoutes);
app.use('/api/vehicles', generalLimiter, vehicleRoutes);
app.use('/api/battery', generalLimiter, batteryRoutes);
app.use('/api/motor', generalLimiter, motorRoutes);
app.use('/api/faults', generalLimiter, faultsRoutes);
app.use('/api/database-logs', generalLimiter, databaseLogsRoutes);
app.use('/api/config', generalLimiter, configRoutes);
app.use('/api/telemetry', generalLimiter, telemetryRoutes); // general first
app.use('/api/vcu', generalLimiter, vcuRoutes);
app.use('/api/hmi', generalLimiter, hmiRoutes);

/* =========================
   SPECIAL: Live/Telemetry Polling
========================= */
// If you have a specific high-frequency live endpoint, apply liveRateLimiter inside telemetryRoutes or vehicleRoutes
// Example inside routes/telemetry.js:
// router.get('/live', liveRateLimiter, liveController);

/* =========================
   404 + ERROR HANDLER
========================= */
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  console.error(err); // Extra visibility during dev/test
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;