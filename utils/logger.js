// utils/logger.js
const fs = require("fs");
const path = require("path");

const logsDir = path.join(__dirname, "../../logs");
const logFile = path.join(logsDir, "app.log");

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Format timestamp in IST (human + sortable)
 */
const getISTTime = () =>
  new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });

/**
 * Normalize objects safely
 */
const serialize = (val) => {
  if (val instanceof Error) {
    return {
      message: val.message,
      code: val.code,
      detail: val.detail,
      where: val.where,
      hint: val.hint,
      stack: val.stack?.split("\n").slice(0, 6).join("\n"),
    };
  }
  return val;
};

/**
 * Core logger
 */
const writeLog = (level, message, meta = {}) => {
  const logEntry = {
    time: getISTTime(),
    level: level.toUpperCase(),
    msg: message,
    ...serialize(meta),
  };

  const line = JSON.stringify(logEntry) + "\n";

  // Console (pretty)
  if (level === "error") {
    console.error(logEntry);
  } else if (level === "warn") {
    console.warn(logEntry);
  } else {
    console.log(logEntry);
  }

  // File (non-blocking)
  fs.appendFile(logFile, line, "utf8", (err) => {
    if (err) {
      console.error("Log write failed:", err.message);
    }
  });
};

module.exports = {
  info: (msg, meta) => writeLog("info", msg, meta),
  warn: (msg, meta) => writeLog("warn", msg, meta),
  error: (msg, meta) => writeLog("error", msg, meta),
};
