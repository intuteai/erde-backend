// routes/config.js
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// POST /api/config/can-mapping
router.post('/can-mapping', authenticateToken, checkPermission('config', 'write'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const vehicleId = req.body.vehicle_master_id;
  if (!vehicleId) return res.status(400).json({ error: 'vehicle_master_id required' });

  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);

    const insertQuery = `
      INSERT INTO vehicle_can_signals (
        vehicle_master_id, component, parameter, can_id,
        byte_offset, bit_length, scale, value_offset, unit, signed, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (vehicle_master_id, can_id, parameter) DO UPDATE SET
        byte_offset = EXCLUDED.byte_offset,
        bit_length = EXCLUDED.bit_length,
        scale = EXCLUDED.scale,
        value_offset = EXCLUDED.value_offset,
        unit = EXCLUDED.unit,
        signed = EXCLUDED.signed,
        description = EXCLUDED.description
    `;

    for (const row of data) {
      await db.query(insertQuery, [
        vehicleId,
        row.component || 'Unknown',
        row.parameter,
        row.can_id,
        row.byte_offset || 0,
        row.bit_length || 16,
        row.scale || 1,
        row.value_offset || 0,
        row.unit || '',
        row.signed === 'true' || row.signed === true,
        row.description || ''
      ]);
    }

    logger.info(`CAN mapping uploaded for vehicle ${vehicleId}: ${data.length} signals`);
    res.json({ success: true, count: data.length });
  } catch (err) {
    logger.error(`CAN upload error: ${err.message}`);
    res.status(500).json({ error: 'Upload failed' });
  } finally {
    // Clean up
    require('fs').unlink(req.file.path, () => {});
  }
});

module.exports = router;