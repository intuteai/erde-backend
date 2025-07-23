const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const AxleOil = require('../models/axleOil');
const redis = require('../config/redis');

router.get('/:vehicle_type', authenticateToken, async (req, res) => {
  try {
    const { vehicle_type } = req.params;
    const cacheKey = `axle_oil_${vehicle_type}`;

    const cached = await redis.get(cacheKey);
    if (cached && req.query.force_refresh !== 'true') {
      return res.json(JSON.parse(cached));
    }

    const data = await AxleOil.getByVehicleType(vehicle_type.toLowerCase());
    await redis.setEx(cacheKey, 300, JSON.stringify(data));

    res.json({ vehicle_type, data });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;