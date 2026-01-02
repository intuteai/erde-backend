// server.js
const http = require("http");
const { Server } = require("socket.io");
const app = require("./app");
const logger = require("./utils/logger");

/* =========================
   INIT MODULES
========================= */
const initSocketIO = require("./socket.io");          // Socket.IO handlers for frontend
const initRawWebSocket = require("./config/socket");  // Raw WS (AWS / CAN) → bridges to Socket.IO
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
});

/* =========================
   MAKE SOCKET.IO GLOBALLY ACCESSIBLE
========================= */
// Critical: Store io on the Express app so raw WebSocket can access it
app.set("io", io);

// Pass to services that need direct access
telemetryService.setSocketIO(io);

/* =========================
   REGISTER REALTIME LAYERS
========================= */

// 1️⃣ Socket.IO for React Frontend (root namespace)
initSocketIO(io);

// 2️⃣ Raw WebSocket (/aws-ws) — now with access to io for broadcasting live data
initRawWebSocket(server, app);  // ← Pass 'app' here

/* =========================
   START SERVER
========================= */
server.listen(PORT, "0.0.0.0", () => {
  logger.info(`EV Dashboard Backend LIVE on http://0.0.0.0:${PORT}`);
});