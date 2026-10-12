// raw-can-trial/index.js
// Raw CAN shadow trial. Everything for the trial lives in this folder;
// app.js only calls mount(). See README.md for enabling and removal.
const express = require('express');
const zlib = require('zlib');
const { rateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const router = require('./route');

const BASE_PATH = '/api/telemetry/raw-can';
const MAX_BODY = '128kb';
const MAX_BODY_BYTES = 128 * 1024;

const rawCanLimiter = rateLimiter({
  windowMs: 60_000,
  max: 600,
  keyPrefix: 'rawcan',
});

// A misbehaving client can send several requests a second: log one line per
// window and kind, with a count of the ones not logged.
const LOG_WINDOW_MS = 30_000;
const logWindows = new Map();
const logThrottled = (kind, message, meta) => {
  const now = Date.now();
  const w = logWindows.get(kind) || { start: 0, skipped: 0 };
  if (now - w.start < LOG_WINDOW_MS) {
    w.skipped += 1;
    logWindows.set(kind, w);
    return;
  }
  logger.warn(message, { ...meta, notLoggedSinceLast: w.skipped });
  logWindows.set(kind, { start: now, skipped: 0 });
};

const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

const bodyError = (status, type, message, buf) => {
  const err = new Error(message);
  err.status = status;
  err.type = type;
  // First bytes of what could not be parsed, to diagnose a client from the log.
  if (buf) err.bodyPreview = buf.subarray(0, 24).toString('hex');
  return err;
};

/**
 * Turns the raw request body into req.body. express.raw() has already removed one
 * layer of gzip (Content-Encoding). React Native on Android can compress a body a
 * second time when that header is set, so a body that is still gzip is unwrapped
 * once more instead of being rejected.
 */
const parseBody = (req, res, next) => {
  let buf = req.body;
  if (!Buffer.isBuffer(buf)) { // no body, or not application/json: validation rejects it
    req.body = {};
    return next();
  }

  if (isGzip(buf)) {
    try {
      buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_BODY_BYTES });
    } catch (e) {
      const tooLarge = e.code === 'ERR_BUFFER_TOO_LARGE';
      return next(bodyError(tooLarge ? 413 : 400, tooLarge ? 'entity.too.large' : 'entity.parse.failed', e.message, buf));
    }
    logThrottled('double-gzip', '[raw-can] Body was gzip-compressed twice; unwrapped and accepted', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  try {
    req.body = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return next(bodyError(400, 'entity.parse.failed', e.message, buf));
  }
  return next();
};

// Turns body errors (oversized, malformed, unsupported encoding) into the
// trial's response shape instead of the app's generic handler, and logs them:
// these requests never reach the route's own logging.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status < 500) {
    logThrottled('body-rejected', '[raw-can] Request body rejected', {
      status,
      reason: err.type || err.message,
      detail: err.message,
      bodyPreview: err.bodyPreview,
      contentType: req.headers['content-type'],
      contentEncoding: req.headers['content-encoding'],
      contentLength: req.headers['content-length'],
      ip: req.ip,
    });
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
  app.use(
    BASE_PATH,
    rawCanLimiter,
    express.raw({ type: 'application/json', limit: MAX_BODY }),
    parseBody,
    router,
    errorHandler
  );
};

module.exports = { mount };
