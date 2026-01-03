// server.js
const http = require("http");
const { Server } = require("socket.io");
const app = require("./app");
const logger = require("./utils/logger");

/* =========================
   TRUST PROXY (IMPORTANT)
========================= */
/**
 * Required when running behind:
 * - AWS ALB / ELB
 * - NGINX
 * - Cloudflare
 *
 * Ensures req.ip is the REAL client IP
 * (critical for rate limiting)
 */
app.set("trust proxy", true);

/* =========================
   INIT MODULES
========================= */
const initSocketIO = require("./socket.io");          // Socket.IO → React frontend
const initRawWebSocket = require("./config/socket");  // Raw WS (AWS / CAN → Socket.IO)
const telemetryService = require("./services/telemetryService");

const PORT = process.env.SERVER_PORT || 5000;

/* =========================
   HTTP SERVER
========================= */
const server = http.createServer(app);

/* =========================
   SOCKET.IO SERVER
========================= */
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://analytics.erdeenergy.in",
    ],
    credentials: true,
  },

  // Helps with reconnects & unstable networks
  pingTimeout: 20000,
  pingInterval: 25000,
});

/* =========================
   MAKE SOCKET.IO GLOBALLY ACCESSIBLE
========================= */
/**
 * Critical:
 * - Express routes
 * - Raw WebSocket server
 * - Telemetry services
 * all need access to io
 */
app.set("io", io);
telemetryService.setSocketIO(io);

/* =========================
   REGISTER REALTIME LAYERS — CORRECT ORDER!
========================= */

// 1️⃣ Initialize Socket.IO for frontend clients FIRST
initSocketIO(io);

// 2️⃣ Initialize Raw WebSocket bridge SECOND
//     → Now it can safely access app.get("io")
initRawWebSocket(server, app);

/* =========================
   START SERVER
========================= */
server.listen(PORT, "0.0.0.0", () => {
  logger.info(`EV Dashboard Backend LIVE on http://0.0.0.0:${PORT}`);
});

/* =========================
   GRACEFUL SHUTDOWN (OPTIONAL BUT RECOMMENDED)
========================= */
process.on("SIGTERM", () => {
  logger.warn("SIGTERM received. Shutting down gracefully...");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.warn("SIGINT received. Shutting down gracefully...");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});