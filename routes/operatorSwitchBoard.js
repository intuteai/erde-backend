const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth');
const OperatorSwitchBoard = require('../models/operatorSwitchBoard');
const redis = require('../config/redis');

router.get('/:vehicle_type', authenticateToken, async (req, res) => {
  try {
    const { vehicle_type } = req.params;
    const cacheKey = `operator_switch_board_${vehicle_type.toLowerCase()}`;

    const cached = await redis.get(cacheKey);
    if (cached && req.query.force_refresh !== 'true') {
      return res.json(JSON.parse(cached));
    }

    const data = await OperatorSwitchBoard.getByVehicleType(vehicle_type.toLowerCase());
    await redis.setEx(cacheKey, 300, JSON.stringify(data));

    res.json({ vehicle_type, data });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
