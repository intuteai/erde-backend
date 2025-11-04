// routes/vcuHmi.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'vcu_hmi';

// GET all
router.get('/', authenticateToken, checkPermission(MODULE, 'read'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
         vcu_hmi_id, vcu_make, vcu_model, vcu_specs,
         hmi_make, hmi_model, hmi_specs, created_at
       FROM vcu_hmi_master
       ORDER BY vcu_make, vcu_model`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error(`GET /vcu-hmi error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET by ID
router.get('/:id', authenticateToken, checkPermission(MODULE, 'read'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(`SELECT * FROM vcu_hmi_master WHERE vcu_hmi_id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`GET /vcu-hmi/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// CREATE
router.post('/', authenticateToken, checkPermission(MODULE, 'write'), async (req, res) => {
  const { vcu_make, vcu_model, vcu_specs, hmi_make, hmi_model, hmi_specs } = req.body;
  if (!vcu_make || !vcu_model) {
    return res.status(400).json({ error: 'vcu_make and vcu_model required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO vcu_hmi_master (
        vcu_make, vcu_model, vcu_specs, hmi_make, hmi_model, hmi_specs, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING vcu_hmi_id`,
      [vcu_make, vcu_model, vcu_specs || null, hmi_make || null, hmi_model || null, hmi_specs || null, req.user.user_id]
    );
    logger.info(`VCU/HMI created: ${vcu_make} ${vcu_model}`);
    res.status(201).json({ vcu_hmi_id: result.rows[0].vcu_hmi_id });
  } catch (err) {
    logger.error(`POST /vcu-hmi error: ${err.message}`);
    res.status(400).json({ error: 'VCU or HMI combination already exists' });
  }
});

// UPDATE
router.put('/:id', authenticateToken, checkPermission(MODULE, 'write'), async (req, res) => {
  const { id } = req.params;
  const fields = req.body;
  const allowed = ['vcu_make', 'vcu_model', 'vcu_specs', 'hmi_make', 'hmi_model', 'hmi_specs'];
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

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(id);
  try {
    const result = await db.query(
      `UPDATE vcu_hmi_master SET ${updates.join(', ')}, updated_at = NOW() WHERE vcu_hmi_id = $${i}`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`PUT /vcu-hmi/${id} error: ${err.message}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE
router.delete('/:id', authenticateToken, checkPermission(MODULE, 'delete'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(`DELETE FROM vcu_hmi_master WHERE vcu_hmi_id = $1 RETURNING vcu_hmi_id`, [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`DELETE /vcu-hmi/${id} error: ${err.message}`);
    res.status(400).json({ error: 'Cannot delete: used in vehicle_master' });
  }
});

module.exports = router;