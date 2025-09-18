const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const logger = require('../utils/logger');

const router = express.Router();

// Middleware to verify JWT
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.error('Battery route: Missing or invalid authorization header');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    logger.error('Battery route: Invalid token:', err.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Get battery data
router.get('/', authenticate, async (req, res) => {
  const deviceId = req.query.device_id || 'VCL001';
  try {
    const data = await db.query('battery', { device_id: deviceId });
    logger.info(`Fetched battery data for device ${deviceId}`);
    res.json(data);
  } catch (err) {
    logger.error(`Error fetching battery data for ${deviceId}:`, err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;