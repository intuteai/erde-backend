// config/socket.js
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const { parseCanDataWithDB } = require("../services/dbParser");
const db = require("../config/postgres");

require("dotenv").config();

const initWebSocket = (server) => {
  const wss = new WebSocket.Server({ noServer: true });
  const awsWsPool = new Map();

  // Manual upgrade: only handle /aws-ws
  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/aws-ws")) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const deviceId = url.searchParams.get("device_id") || "VCL001";

    // JWT Auth
    if (!token) {
      logger.warn(`WS rejected: No token (${deviceId})`);
      return ws.close(4001, "Token missing");
    }

    let user;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
      ws.user = user;
      ws.deviceId = deviceId;
      logger.info(`Raw WS connected: ${user.username} → ${deviceId}`);
    } catch (err) {
      logger.warn(`Invalid token from ${req.socket.remoteAddress}`);
      return ws.close(4002, "Invalid token");
    }

    // Map deviceId → vehicle_master_id
    let vehicleMasterId;
    try {
      const res = await db.query(
        "SELECT vehicle_master_id FROM vehicle_master WHERE vehicle_unique_id = $1",
        [deviceId]
      );
      if (!res.rows.length) {
        logger.error(`Vehicle not found: ${deviceId}`);
        return ws.close(4004, "Vehicle not found");
      }
      vehicleMasterId = res.rows[0].vehicle_master_id;
      ws.vehicleMasterId = vehicleMasterId;
    } catch (err) {
      logger.error(`DB error during connect: ${err.message}`);
      return ws.close(5000, "Server error");
    }

    // Get or create AWS WS connection (one per device)
    let awsWs = awsWsPool.get(deviceId);

    if (!awsWs || awsWs.readyState !== WebSocket.OPEN) {
      awsWs = new WebSocket(`${process.env.AWS_WS_URL}?device_id=${deviceId}`, {
        headers: {
          Authorization: `Bearer ${process.env.AWS_API_KEY}`,
        },
      });

      awsWs.on("open", () => {
        awsWs.send(JSON.stringify({ action: "subscribe", device_id: deviceId }));
        logger.info(`AWS WS subscribed: ${deviceId}`);
      });

      awsWs.on("message", async (data) => {
        try {
          const raw = JSON.parse(data.toString());
          const payloadHex = raw.payload || raw.items?.[0]?.payload;
          if (!payloadHex) return;

          const parsed = await parseCanDataWithDB(payloadHex, vehicleMasterId);

          // === SAVE TO DB ===
          const keys = Object.keys(parsed).filter((k) => k !== "timestamp" && k !== "fault_code" && k !== "fault_description");
          if (keys.length > 0) {
            const columns = ["vehicle_master_id", "recorded_at", ...keys].join(", ");
            const values = [vehicleMasterId, new Date(), ...keys.map(k => parsed[k])];
            const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

            await db.query(
              `INSERT INTO live_values (${columns}) VALUES (${placeholders})
               ON CONFLICT (vehicle_master_id) DO UPDATE SET
               ${keys.map(k => `${k} = EXCLUDED.${k}`).join(", ")}`,
              values
            );
          }

          // === SAVE DTC ===
          if (parsed.fault_code) {
            await db.query(
              `INSERT INTO dtc_events (vehicle_master_id, code, description, recorded_at)
               VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
              [vehicleMasterId, parsed.fault_code, parsed.fault_description || "Unknown"]
            );
          }

          // === BROADCAST TO ALL CONNECTED RAW WS CLIENTS ===
          const broadcast = {
            ...parsed,
            timestamp: Date.now(),
            deviceId,
          };

          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.deviceId === deviceId) {
              client.send(JSON.stringify(broadcast));
            }
          });

          logger.info(`Live data processed & broadcasted: ${deviceId}`);
        } catch (err) {
          logger.error(`AWS message processing error: ${err.message}`);
        }
      });

      awsWs.on("close", (code, reason) => {
        logger.info(`AWS WS closed (${code}): ${deviceId} - ${reason.toString()}`);
        awsWsPool.delete(deviceId);
      });

      awsWs.on("error", (err) => {
        logger.error(`AWS WS error (${deviceId}): ${err.message}`);
        awsWsPool.delete(deviceId);
      });

      awsWsPool.set(deviceId, awsWs);
    }

    // Forward client messages to AWS (optional commands)
    ws.on("message", (msg) => {
      if (awsWs.readyState === WebSocket.OPEN) {
        awsWs.send(msg);
      }
    });

    // Cleanup on client disconnect
    ws.on("close", () => {
      logger.info(`Raw WS disconnected: ${ws.user.username} (${deviceId})`);

      const hasActiveClients = [...wss.clients].some(
        (c) => c.readyState === WebSocket.OPEN && c.deviceId === deviceId
      );

      if (!hasActiveClients && awsWs) {
        awsWs.close();
        awsWsPool.delete(deviceId);
        logger.info(`AWS WS closed due to no clients: ${deviceId}`);
      }
    });
  });

  return wss;
};

module.exports = initWebSocket;