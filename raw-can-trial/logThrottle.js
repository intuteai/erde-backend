// raw-can-trial/logThrottle.js
// The tablet sends several requests a second, so anything logged per request
// would flood the log. One line per kind per window, with a count of the rest.
const logger = require('../utils/logger');

const LOG_WINDOW_MS = 30_000;
const windows = new Map();

/** Logs at most once per LOG_WINDOW_MS for each `kind`. */
const logThrottled = (kind, level, message, meta = {}) => {
  const now = Date.now();
  const w = windows.get(kind) || { start: 0, skipped: 0 };
  if (now - w.start < LOG_WINDOW_MS) {
    w.skipped += 1;
    windows.set(kind, w);
    return false;
  }
  logger[level](message, { ...meta, notLoggedSinceLast: w.skipped });
  windows.set(kind, { start: now, skipped: 0 });
  return true;
};

module.exports = { logThrottled, LOG_WINDOW_MS };
