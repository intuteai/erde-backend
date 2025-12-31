require('dotenv').config();
const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');

/* ROUTES - Explicit .js extensions for reliable module resolution */
const authRoutes             = require('./routes/auth.js');
const customerRoutes         = require('./routes/customer.js');
const vehicleTypeRoutes      = require('./routes/vehicleType.js');
const vehicleCategoryRoutes  = require('./routes/vehicleCategory.js');
const vehicleMasterRoutes    = require('./routes/vehicle-master.js');  // ← Fixed: was missing .js
const vehicleRoutes          = require('./routes/vehicle.js');
const batteryRoutes          = require('./routes/battery.js');
const motorRoutes            = require('./routes/motor.js');
const faultsRoutes           = require('./routes/faults.js');
const configRoutes           = require('./routes/config.js');
const telemetryRoutes        = require('./routes/telemetry.js');
const databaseLogsRoutes     = require('./routes/databaseLogs.js');
const vcuRoutes              = require('./routes/vcu.js');
const hmiRoutes              = require('./routes/hmi.js');

/* RATE LIMITERS */
const { generalLimiter } = require('./middleware/rateLimiter');

const app = express();

/* =========================
   CORS CONFIG
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
      // Allow requests with no origin (like mobile apps, Postman, etc.)
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
app.use('/api/auth', authRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

/* =========================
   PROTECTED API ROUTES (WITH GENERAL RATE LIMIT)
========================= */
app.use('/api/customers',         generalLimiter, customerRoutes);
app.use('/api/vehicle-types',     generalLimiter, vehicleTypeRoutes);
app.use('/api/vehicle-categories',generalLimiter, vehicleCategoryRoutes);
app.use('/api/vehicle-master',    generalLimiter, vehicleMasterRoutes);   // Now properly loaded
app.use('/api/vehicles',          generalLimiter, vehicleRoutes);
app.use('/api/battery',           generalLimiter, batteryRoutes);
app.use('/api/motor',             generalLimiter, motorRoutes);
app.use('/api/faults',            generalLimiter, faultsRoutes);
app.use('/api/database-logs',     generalLimiter, databaseLogsRoutes);
app.use('/api/config',            generalLimiter, configRoutes);
app.use('/api/telemetry',         generalLimiter, telemetryRoutes);
app.use('/api/vcu',               generalLimiter, vcuRoutes);
app.use('/api/hmi',               generalLimiter, hmiRoutes);

/* =========================
   404 HANDLER
========================= */
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  console.error(err); // Extra visibility in dev
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

module.exports = app;