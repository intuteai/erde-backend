const http = require("http");
const { Server } = require("socket.io");
const app = require("./app");
const logger = require("./utils/logger");

/* =========================
   INIT MODULES
========================= */
const initSocketIO = require("./socket.io");          // Socket.IO handlers
const initRawWebSocket = require("./config/socket");  // Raw WS (AWS / CAN)
const telemetryService = require("./services/telemetryService");

const PORT = process.env.SERVER_PORT || 5000;

/* =========================
   HTTP SERVER
========================= */
const server = http.createServer(app);

/* =========================
   SOCKET.IO SERVER (MUST BE FIRST)
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
   INJECT SOCKET.IO INTO SERVICES
========================= */
telemetryService.setSocketIO(io);

/* =========================
   REGISTER REALTIME LAYERS
========================= */
// 1️⃣ Socket.IO (Frontend)
initSocketIO(io);

// 2️⃣ Raw WebSocket (AWS / Devices) — scoped to /aws-ws internally
initRawWebSocket(server);

/* =========================
   START SERVER
========================= */
server.listen(PORT, () => {
  logger.info(`EV Dashboard Backend LIVE on http://localhost:${PORT}`);
});
