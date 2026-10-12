// raw-can-trial/index.js
// Raw CAN shadow trial. Everything for the trial lives in this folder;
// app.js only calls mount(). See README.md for enabling and removal.
const zlib = require('zlib');
const { rateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const { logThrottled } = require('./logThrottle');
const router = require('./route');

const BASE_PATH = '/api/telemetry/raw-can';
const MAX_BODY_BYTES = 128 * 1024; // applies to the bytes received and to the body after decompression
const MAX_GZIP_LAYERS = 2;

const rawCanLimiter = rateLimiter({
  windowMs: 60_000,
  max: 600,
  keyPrefix: 'rawcan',
});

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
 * Collects the request body as received, without interpreting Content-Encoding.
 * The trial reads the body itself (instead of express.json) because the tablet's
 * networking layer does not reliably match the header to what it sends.
 */
const readBody = (req, res, next) => {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) return next(); // validation rejects it

  let size = 0;
  let finished = false;
  const chunks = [];
  const fail = (err) => {
    if (finished) return;
    finished = true;
    chunks.length = 0;
    req.resume(); // let the rest of the upload drain so the reply can be sent
    next(err);
  };

  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    return fail(bodyError(413, 'entity.too.large', 'request entity too large'));
  }
  req.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return fail(bodyError(413, 'entity.too.large', 'request entity too large'));
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    req.rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', (e) => fail(bodyError(400, 'request.aborted', e.message)));
  return undefined;
};

/**
 * Turns the collected bytes into req.body. The body is accepted whether it is
 * plain JSON, gzip, or gzip inside gzip: compression is detected from the bytes,
 * not from the Content-Encoding header. (React Native on Android was found to
 * compress an already-compressed body again when the header says gzip.)
 */
const parseBody = (req, res, next) => {
  let buf = req.rawBody;
  if (!buf) {
    req.body = {};
    return next();
  }

  let layers = 0;
  while (isGzip(buf) && layers < MAX_GZIP_LAYERS) {
    try {
      buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_BODY_BYTES });
    } catch (e) {
      const tooLarge = e.code === 'ERR_BUFFER_TOO_LARGE';
      return next(bodyError(tooLarge ? 413 : 400, tooLarge ? 'entity.too.large' : 'entity.parse.failed', e.message, buf));
    }
    layers += 1;
  }

  const labelledGzip = /gzip/i.test(String(req.headers['content-encoding'] || ''));
  if (layers !== (labelledGzip ? 1 : 0)) {
    logThrottled(`gzip-layers-${layers}-${labelledGzip}`, 'warn', '[raw-can] Body compression did not match its Content-Encoding header; accepted', {
      gzipLayers: layers,
      contentEncoding: req.headers['content-encoding'] || null,
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

// Turns body errors (oversized, malformed) into the trial's response shape
// instead of the app's generic handler, and logs them: these requests never
// reach the route's own logging.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status < 500) {
    logThrottled('body-rejected', 'warn', '[raw-can] Request body rejected', {
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
 * express.json() so the trial reads its own request bodies.
 */
const mount = (app) => {
  app.use(BASE_PATH, rawCanLimiter, readBody, parseBody, router, errorHandler);
};

module.exports = { mount };
