const express = require('express');
const jwt = require('jsonwebtoken');
const { getConfig } = require('../config/config'); // Adjust path if needed
const logger = require('../utils/logger');

const router = express.Router();

// Middleware to verify JWT (reuse from your other routes)
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.error('Config route: Missing or invalid authorization header');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logger.error(`Config route: Invalid token: ${err.message}`);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// GET /api/config - Fetch device configuration
router.get('/', authenticate, (req, res) => {
  const deviceId = req.query.device_id || 'VCL001';
  const config = getConfig(deviceId);
  if (!config) {
    logger.warn(`No config found for deviceId ${deviceId}`);
    return res.status(404).json({ error: 'Config not found for device' });
  }
  logger.info(`Served config for device: ${deviceId}`);
  res.json(config);
});

module.exports = router;