// config/socket.js
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const { parseCanDataWithDB } = require("../services/dbParser");
const db = require("../config/postgres");
const { formatLiveData } = require("../utils/formatLiveData"); // ← NEW
require("dotenv").config();

/**
 * Initialize Raw WebSocket Server for /aws-ws
 * Bridges parsed CAN data → DB → formatted broadcast to Socket.IO frontend
 */
const initWebSocket = (server, app) => {
  const wss = new WebSocket.Server({ noServer: true });
  const awsWsPool = new Map();

  server.on("upgrade", (req, socket, head) => {
    const { url } = req;

    if (url.startsWith("/socket.io")) {
      return;
    }

    const path = url.split("?")[0];
    if (path !== "/aws-ws") {
      logger.warn(`Rejected invalid WS upgrade attempt: ${url}`);
      socket.destroy();
      return;
    }

    logger.info(`Raw WS upgrade accepted: ${url}`);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (ws, req) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch (err) {
      logger.warn(`Invalid URL in WS connection: ${req.url}`);
      return ws.close(4000, "Invalid URL");
    }

    const token = url.searchParams.get("token");
    const deviceId = url.searchParams.get("device_id") || "VCL001";

    if (!token) {
      logger.warn(`WS connection rejected: Missing token (${deviceId})`);
      return ws.close(4001, "Token missing");
    }

    let user;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
      ws.user = user;
      ws.deviceId = deviceId;
      logger.info(`Raw WS connected: ${user.username} → ${deviceId}`);
    } catch (err) {
      logger.warn(`WS connection rejected: Invalid token (${deviceId}) - ${err.message}`);
      return ws.close(4002, "Invalid token");
    }

    let vehicleMasterId;
    try {
      const res = await db.query(
        `SELECT vehicle_master_id FROM vehicle_master WHERE vehicle_unique_id = $1`,
        [deviceId]
      );

      if (!res.rows.length) {
        logger.error(`Vehicle not found in DB: ${deviceId}`);
        return ws.close(4004, "Vehicle not found");
      }

      vehicleMasterId = res.rows[0].vehicle_master_id;
      ws.vehicleMasterId = vehicleMasterId;
    } catch (err) {
      logger.error(`Database error during WS connection: ${err.message}`);
      return ws.close(5000, "Server error");
    }

    let awsWs = awsWsPool.get(deviceId);

    if (!awsWs || awsWs.readyState !== WebSocket.OPEN) {
      try {
        awsWs = new WebSocket(`${process.env.AWS_WS_URL}?device_id=${deviceId}`, {
          headers: {
            Authorization: `Bearer ${process.env.AWS_API_KEY}`,
          },
          handshakeTimeout: 10000,
        });

        awsWs.on("open", () => {
          awsWs.send(JSON.stringify({ action: "subscribe", device_id: deviceId }));
          logger.info(`AWS WS connected and subscribed: ${deviceId}`);
        });

        awsWs.on("message", async (data) => {
          try {
            const raw = JSON.parse(data.toString());
            const payloadHex = raw.payload || raw.items?.[0]?.payload;
            if (!payloadHex) return;

            const parsed = await parseCanDataWithDB(payloadHex, vehicleMasterId);

            // === 1. Save live values to DB ===
            const keys = Object.keys(parsed).filter(
              (k) => !["timestamp", "fault_code", "fault_description"].includes(k)
            );

            if (keys.length > 0) {
              const columns = ["vehicle_master_id", "recorded_at", ...keys].join(", ");
              const values = [vehicleMasterId, new Date(), ...keys.map((k) => parsed[k])];
              const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

              await db.query(
                `INSERT INTO live_values (${columns}) VALUES (${placeholders})
                 ON CONFLICT (vehicle_master_id) DO UPDATE SET
                 ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(", ")}`,
                values
              );
            }

            // === 2. Save DTC if present ===
            if (parsed.fault_code) {
              await db.query(
                `INSERT INTO dtc_events (vehicle_master_id, code, description, recorded_at)
                 VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
                [vehicleMasterId, parsed.fault_code, parsed.fault_description || "Unknown"]
              );
            }

            // === 3. Broadcast to raw WS clients (optional – keep if you have raw clients) ===
            const rawBroadcast = { ...parsed, timestamp: Date.now(), deviceId };
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN && client.deviceId === deviceId) {
                try {
                  client.send(JSON.stringify(rawBroadcast));
                } catch (e) {
                  logger.warn(`Failed to send to raw client (${deviceId}): ${e.message}`);
                }
              }
            });

            // === 4. Broadcast FORMATTED data to Socket.IO frontend clients ===
            const io = app.get("io");
            if (io) {
              try {
                // Read the latest row from DB (ensures we have full persisted data)
                const latestRes = await db.query(
                  `SELECT * FROM live_values 
                   WHERE vehicle_master_id = $1 
                   ORDER BY recorded_at DESC 
                   LIMIT 1`,
                  [vehicleMasterId]
                );

                if (latestRes.rows.length > 0) {
                  const formatted = formatLiveData(latestRes.rows[0]);
                  const room = `vehicle:${vehicleMasterId}`;
                  io.to(room).emit("live_update", formatted);
                  logger.info(`Broadcasted formatted live_update to Socket.IO room: ${room}`);
                }
              } catch (err) {
                logger.error(`Error formatting or broadcasting live data: ${err.message}`);
              }
            } else {
              logger.warn("Socket.IO instance not available for broadcasting");
            }

            logger.info(`Live data processed & broadcasted: ${deviceId}`);
          } catch (err) {
            logger.error(`Error processing AWS message (${deviceId}): ${err.message}`);
          }
        });

        awsWs.on("close", (code, reason) => {
          logger.warn(`AWS WS closed (${deviceId}) - Code: ${code}, Reason: ${reason.toString()}`);
          awsWsPool.delete(deviceId);
        });

        awsWs.on("error", (err) => {
          logger.error(`AWS WS error (${deviceId}): ${err.message}`);
          awsWsPool.delete(deviceId);
        });

        awsWsPool.set(deviceId, awsWs);
      } catch (err) {
        logger.error(`Failed to create AWS WS (${deviceId}): ${err.message}`);
        return ws.close(5001, "Failed to connect to data source");
      }
    }

    ws.on("message", (msg) => {
      if (awsWs?.readyState === WebSocket.OPEN) {
        try {
          awsWs.send(msg);
        } catch (err) {
          logger.error(`Failed to forward to AWS (${deviceId}): ${err.message}`);
        }
      }
    });

    ws.on("close", (code) => {
      logger.info(`Raw WS disconnected: ${ws.user?.username || "unknown"} (${deviceId}) - Code: ${code}`);

      const hasActiveClients = [...wss.clients].some(
        (c) => c.readyState === WebSocket.OPEN && c.deviceId === deviceId
      );

      if (!hasActiveClients && awsWs) {
        awsWs.close();
        awsWsPool.delete(deviceId);
        logger.info(`AWS WS closed (no clients): ${deviceId}`);
      }
    });

    ws.on("error", (err) => {
      logger.warn(`Raw WS client error (${deviceId}): ${err.message}`);
    });
  });

  return wss;
};

module.exports = initWebSocket;