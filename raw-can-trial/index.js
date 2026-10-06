// raw-can-trial/index.js
// Raw CAN shadow trial. Everything for the trial lives in this folder;
// app.js only calls mount(). See README.md for enabling and removal.
const express = require('express');
const { rateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const router = require('./route');

const BASE_PATH = '/api/telemetry/raw-can';
const MAX_BODY = '128kb';

const rawCanLimiter = rateLimiter({
  windowMs: 60_000,
  max: 600,
  keyPrefix: 'rawcan',
});

// Turns body-parser errors (oversized, malformed, unsupported encoding)
// into the trial's response shape instead of the app's generic handler.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status < 500) {
    return res.status(status).json({ accepted: false, reason: err.type || err.message });
  }
  logger.error('[raw-can] Unhandled error', { message: err.message, stack: err.stack });
  return res.status(500).json({ error: 'Internal server error' });
};

/**
 * Registers the trial route. Must be called before the app's global
 * express.json() so the trial's own 128 KiB limit applies.
 */
const mount = (app) => {
  app.use(BASE_PATH, rawCanLimiter, express.json({ limit: MAX_BODY }), router, errorHandler);
};

module.exports = { mount };
