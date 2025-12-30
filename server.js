const http = require('http');
const WebSocket = require('ws');
const { Server } = require('socket.io');
const app = require('./app');
const logger = require('./utils/logger');

const PORT = process.env.SERVER_PORT || 5000;
const server = http.createServer(app);

/* =========================
   EXISTING WS SERVER (KEEP)
========================= */
const wss = new WebSocket.Server({ server });
// ⬆️ unchanged logic stays here

/* =========================
   NEW: SOCKET.IO SERVER
========================= */
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://analytics.erdeenergy.in',
    ],
    credentials: true,
  },
});

/* =========================
   EXPORT BOTH
========================= */
module.exports = { server, io, wss };

/* =========================
   START SERVER
========================= */
if (require.main === module) {
  server.listen(PORT, () => {
    logger.info(`EV Dashboard Backend LIVE on http://localhost:${PORT}`);
  });
}
