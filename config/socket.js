// config/socket.js
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { parseCanDataWithDB } = require('../services/canParser');
const db = require('../config/postgres');

require('dotenv').config();

const initWebSocket = (server) => {
  const wss = new WebSocket.Server({ server });
  const awsWsPool = new Map();

  wss.on('connection', async (ws, req) => {
    // Extract token & device_id from URL: /?token=...&device_id=VCL001
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const deviceId = url.searchParams.get('device_id') || 'VCL001';

    // === JWT AUTH ===
    if (!token) {
      logger.warn(`WS connection rejected: No token for ${deviceId}`);
      ws.close(4001, 'Token missing');
      return;
    }

    let user;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
      ws.user = user;
      ws.deviceId = deviceId;
      logger.info(`WebSocket connected: ${user.username} → ${deviceId}`);
    } catch (err) {
      logger.warn(`WS token invalid: ${err.message}`);
      ws.close(4002, 'Invalid token');
      return;
    }

    // === MAP deviceId → vehicle_master_id ===
    let vehicleMasterId;
    try {
      const res = await db.query(
        'SELECT vehicle_master_id FROM vehicle_master WHERE vehicle_unique_id = $1',
        [deviceId]
      );
      if (res.rows.length === 0) {
        logger.error(`No vehicle found for deviceId: ${deviceId}`);
        ws.close(4004, 'Vehicle not found');
        return;
      }
      vehicleMasterId = res.rows[0].vehicle_master_id;
      ws.vehicleMasterId = vehicleMasterId;
    } catch (err) {
      logger.error(`DB error on connect: ${err.message}`);
      ws.close(5000, 'Server error');
      return;
    }

    // === AWS WebSocket (One per deviceId) ===
    let awsWs = awsWsPool.get(deviceId);
    if (!awsWs || awsWs.readyState !== WebSocket.OPEN) {
      awsWs = new WebSocket(`${process.env.AWS_WS_URL}?device_id=${deviceId}`, {
        headers: { Authorization: `Bearer ${process.env.AWS_API_KEY}` }
      });

      awsWs.on('open', () => {
        awsWs.send(JSON.stringify({ action: 'subscribe', device_id: deviceId }));
        logger.info(`AWS WS subscribed: ${deviceId}`);
      });

      awsWs.on('message', async (msg) => {
        try {
          const raw = JSON.parse(msg.toString());
          const payloadHex = raw.payload || raw.items?.[0]?.payload;
          if (!payloadHex) return;

          // Parse using DB mapping
          const parsed = await parseCanDataWithDB(payloadHex, vehicleMasterId);

          // Save to live_values
          const keys = Object.keys(parsed).filter(k => k !== 'timestamp');
          if (keys.length > 0) {
            const columns = ['vehicle_master_id', 'recorded_at', ...keys].join(', ');
            const placeholders = keys.map((_, i) => `$${i + 3}`).join(', ');
            const values = [vehicleMasterId, new Date(), ...keys.map(k => parsed[k])];

            await db.query(`
              INSERT INTO live_values (${columns})
              VALUES ($1, $2, ${placeholders})
              ON CONFLICT (vehicle_master_id) DO UPDATE SET
                ${keys.map(k => `${k} = EXCLUDED.${k}`).join(', ')}
            `, values);
          }

          // Save faults
          if (parsed.fault_code) {
            await db.query(`
              INSERT INTO dtc_events (vehicle_master_id, code, description, recorded_at)
              VALUES ($1, $2, $3, NOW())
              ON CONFLICT DO NOTHING
            `, [vehicleMasterId, parsed.fault_code, parsed.fault_description || 'Unknown']);
          }

          // Broadcast to all clients for this device
          const broadcast = { ...parsed, timestamp: Date.now(), deviceId };
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.deviceId === deviceId) {
              client.send(JSON.stringify(broadcast));
            }
          });

          logger.info(`Broadcasted live data for ${deviceId}`);
        } catch (err) {
          logger.error(`AWS message parse error: ${err.message}`);
        }
      });

      awsWs.on('close', () => {
        logger.info(`AWS WS closed: ${deviceId}`);
        awsWsPool.delete(deviceId);
      });

      awsWsPool.set(deviceId, awsWs);
    }

    // Client → AWS (if needed)
    ws.on('message', (msg) => {
      if (awsWs.readyState === WebSocket.OPEN) {
        awsWs.send(msg);
      }
    });

    ws.on('close', () => {
      logger.info(`WS client disconnected: ${ws.user.username} (${deviceId})`);
      // Close AWS WS if no clients left
      const hasClients = Array.from(wss.clients).some(c => c.deviceId === deviceId && c.readyState === WebSocket.OPEN);
      if (!hasClients && awsWs) {
        awsWs.close();
        awsWsPool.delete(deviceId);
      }
    });
  });

  return wss;
};

module.exports = initWebSocket;