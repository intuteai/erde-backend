const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const db = require('./config/postgres');
const { parseCanDataWithDB } = require('./services/dbParser');
const logger = require('./utils/logger');
const app = require('./app');

const PORT = process.env.SERVER_PORT || 5000;

const server = http.createServer(app);

/* =========================
   WEBSOCKET SERVER
========================= */
const wss = new WebSocket.Server({ server });

// ⬇️ KEEP your existing WS logic here (UNCHANGED)

/* =========================
   START SERVER (IMPORTANT)
========================= */
if (require.main === module) {
  server.listen(PORT, () => {
    logger.info(`EV Dashboard Backend LIVE on http://localhost:${PORT}`);
  });
}

module.exports = server;
