const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const logger = require('../utils/logger');

const router = express.Router();

// Middleware to verify JWT
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.error('VehicleHistorical route: Missing or invalid authorization header');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logger.error(`VehicleHistorical route: Invalid token: ${err.message}`);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Get historical vehicle data
router.get('/', authenticate, async (req, res) => {
  const deviceId = req.query.device_id || 'VCL001';
  const period = req.query.period || 'today';

  try {
    // Validate period
    const validPeriods = ['today', 'week', 'month', 'total', 'recent'];
    if (!validPeriods.includes(period)) {
      logger.error(`VehicleHistorical route: Invalid period: ${period}`);
      return res.status(400).json({ error: `Invalid period. Must be one of: ${validPeriods.join(', ')}` });
    }

    const data = await db.queryHistorical(period, { device_id: deviceId });
    logger.info(`Fetched historical vehicle data for ${deviceId} (${period})`);
    res.json(data);
  } catch (err) {
    logger.error(`Error fetching historical vehicle data for ${deviceId} (${period}): ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;