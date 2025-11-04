// utils/logger.js
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../../logs');
const logFile = path.join(logsDir, 'app.log');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const log = (level, message, ...args) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${level.toUpperCase()}: ${message} ${args.join(' ')}\n`;
  console[level](logMessage);
  try {
    fs.appendFileSync(logFile, logMessage, 'utf8');
  } catch (err) {
    console.error(`Failed to write log: ${err.message}`);
  }
};

module.exports = {
  info: (msg, ...args) => log('info', msg, ...args),
  error: (msg, ...args) => log('error', msg, ...args),
  warn: (msg, ...args) => log('warn', msg, ...args),
};