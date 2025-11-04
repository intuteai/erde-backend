// routes/vehicleType.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'vehicle_types';

// GET /api/vehicle-types
router.get('/', authenticateToken, checkPermission(MODULE, 'read'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
         vtype_id, make, model, capacity_kwh, engine_specs,
         wheel_loader, excavator, architecture_diagram, drawings_folder_url,
         created_at, created_by
       FROM vehicle_type_master
       ORDER BY make, model`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error(`GET /vehicle-types error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/vehicle-types/:id
router.get('/:id', authenticateToken, checkPermission(MODULE, 'read'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM vehicle_type_master WHERE vtype_id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`GET /vehicle-types/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/vehicle-types
router.post('/', authenticateToken, checkPermission(MODULE, 'write'), async (req, res) => {
  const {
    make, model, capacity_kwh, engine_specs,
    wheel_loader = false, excavator = false,
    architecture_diagram, drawings_folder_url
  } = req.body;

  if (!make || !model) {
    return res.status(400).json({ error: 'make and model are required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO vehicle_type_master (
        make, model, capacity_kwh, engine_specs,
        wheel_loader, excavator, architecture_diagram, drawings_folder_url,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING vtype_id`,
      [
        make, model, capacity_kwh || null, engine_specs || null,
        wheel_loader, excavator, architecture_diagram || null, drawings_folder_url || null,
        req.user.user_id
      ]
    );
    logger.info(`Vehicle type created: ${make} ${model} by user ${req.user.user_id}`);
    res.status(201).json({ vtype_id: result.rows[0].vtype_id });
  } catch (err) {
    logger.error(`POST /vehicle-types error: ${err.message}`);
    if (err.message.includes('unique')) {
      res.status(400).json({ error: 'Make + Model already exists' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

// PUT /api/vehicle-types/:id
router.put('/:id', authenticateToken, checkPermission(MODULE, 'write'), async (req, res) => {
  const { id } = req.params;
  const fields = req.body;
  const allowed = [
    'make', 'model', 'capacity_kwh', 'engine_specs',
    'wheel_loader', 'excavator', 'architecture_diagram', 'drawings_folder_url'
  ];

  const updates = [];
  const values = [];
  let i = 1;

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = $${i}`);
      values.push(fields[key]);
      i++;
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  values.push(id);
  try {
    const result = await db.query(
      `UPDATE vehicle_type_master 
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE vtype_id = $${i}
       RETURNING vtype_id`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    logger.info(`Vehicle type updated: ${id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`PUT /vehicle-types/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/vehicle-types/:id
router.delete('/:id', authenticateToken, checkPermission(MODULE, 'delete'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM vehicle_type_master WHERE vtype_id = $1 RETURNING vtype_id`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    logger.info(`Vehicle type deleted: ${id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`DELETE /vehicle-types/${id} error: ${err.message}`);
    res.status(400).json({ error: 'Cannot delete: used in vehicle_master' });
  }
});

module.exports = router;