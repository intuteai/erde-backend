require('dotenv').config(); // Load .env variables

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Routes
const authRoutes = require('./routes/auth');
const hvBatteryRoutes = require('./routes/hvBattery');
const btmsRoutes = require('./routes/btms');
const mcuRoutes = require('./routes/mcu');
const dcDcConverterRoutes = require('./routes/dcDcConverter');
const lvBatteryRoutes = require('./routes/lvBattery');
const hvacRoutes = require('./routes/hvac');
const vehiclePeripheralsRoutes = require('./routes/vehiclePeripherals');
const operatorSwitchBoardRoutes = require('./routes/operatorSwitchBoard');
const androidDisplayRoutes = require('./routes/androidDisplay');
const vehicleWideRoutes = require('./routes/vehicleWide');
const transmissionSystemRoutes = require('./routes/transmissionSystem');
const machineIdentificationRoutes = require('./routes/machineIdentification');
const hydraulicSystemRoutes = require('./routes/hydraulicSystem');
const axleOilRoutes = require('./routes/axleOil');

const app = express();
const PORT = process.env.SERVER_PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/hv-battery', hvBatteryRoutes);
app.use('/api/btms', btmsRoutes);
app.use('/api/mcu', mcuRoutes);
app.use('/api/dc-dc-converter', dcDcConverterRoutes);
app.use('/api/lv-battery', lvBatteryRoutes);
app.use('/api/hvac', hvacRoutes);
app.use('/api/vehicle-peripherals', vehiclePeripheralsRoutes);
app.use('/api/operator-switch-board', operatorSwitchBoardRoutes);
app.use('/api/android-display', androidDisplayRoutes);
app.use('/api/vehicle-wide', vehicleWideRoutes);
app.use('/api/transmission-system', transmissionSystemRoutes);
app.use('/api/machine-identification', machineIdentificationRoutes);
app.use('/api/hydraulic-system', hydraulicSystemRoutes);
app.use('/api/axle-oil', axleOilRoutes);

// Start the HTTP server
const server = app.listen(PORT, () => {
  console.log(`✅ EV Dashboard Backend running on port ${PORT} at ${new Date().toString()}`);
});

// WebSocket setup with JWT authentication
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const token = params.get('token');

  if (!token) {
    ws.close(4001, 'Authentication token missing');
    return;
  }

  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
    ws.user = decoded; // Store user info in the connection
    console.log(`🟢 WebSocket auth success: ${ws.user.username}`);
  } catch (err) {
    console.error('🔴 WebSocket token invalid:', err.message);
    ws.close(4002, 'Invalid or expired token');
    return;
  }

  // WebSocket is authenticated, handle messages
  ws.on('message', (message) => {
    console.log(`[${ws.user.username}] → ${message}`);

    // Broadcast to all authenticated clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(`[${ws.user.username}] → ${message}`);
      }
    });
  });

  ws.on('close', () => {
    console.log(`🔌 WebSocket session closed for: ${ws.user.username}`);
  });
});
