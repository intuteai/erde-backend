// routes/vehicleType.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'vehicle_types';

/* ============================================================
   GET ALL VEHICLE TYPES (WITH CATEGORY NAME)
============================================================ */
router.get(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    try {
      const result = await db.query(`
        SELECT
          v.vtype_id,
          v.make,
          v.model,
          v.capacity_tonne,
          v.category_id,
          c.category_name,
          v.architecture_diagram,
          v.drawings_folder_url,
          v.created_at
        FROM vehicle_type_master v
        LEFT JOIN vehicle_categories c ON c.category_id = v.category_id
        ORDER BY c.category_name, v.make, v.model
      `);

      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /api/vehicle-types error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   CREATE VEHICLE TYPE
============================================================ */
router.post(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const {
      make,
      model,
      capacity_tonne,
      category_id,
      architecture_diagram,
      drawings_folder_url
    } = req.body;

    if (!make || !model || !category_id) {
      return res.status(400).json({
        error: 'make, model, and category_id are required'
      });
    }

    if (typeof make !== 'string' || typeof model !== 'string' || !make.trim() || !model.trim()) {
      return res.status(400).json({ error: 'Invalid make or model' });
    }

    try {
      const result = await db.query(
        `
        INSERT INTO vehicle_type_master (
          make,
          model,
          capacity_tonne,
          category_id,
          architecture_diagram,
          drawings_folder_url,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING vtype_id
        `,
        [
          make.trim(),
          model.trim(),
          capacity_tonne ? parseFloat(capacity_tonne) : null, // ensure numeric
          category_id,
          architecture_diagram || null,
          drawings_folder_url || null,
          req.user.user_id
        ]
      );

      res.status(201).json({ vtype_id: result.rows[0].vtype_id });
    } catch (err) {
      logger.error(`POST /api/vehicle-types error: ${err.message}`);
      if (err.code === '23505') {
        // Unique violation on make + model
        res.status(400).json({ error: 'Make + Model already exists' });
      } else if (err.code === '23503') {
        res.status(400).json({ error: 'Invalid category_id: category does not exist' });
      } else {
        res.status(500).json({ error: 'Server error' });
      }
    }
  }
);

/* ============================================================
   UPDATE VEHICLE TYPE
============================================================ */
router.put(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const { id } = req.params;
    const {
      make,
      model,
      capacity_tonne,
      category_id,
      architecture_diagram,
      drawings_folder_url
    } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid vehicle type id' });
    }

    // Check if record exists
    const existing = await db.query(
      `SELECT vtype_id FROM vehicle_type_master WHERE vtype_id = $1`,
      [id]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Vehicle type not found' });
    }

    // Validate required fields
    if (!make || !model || typeof make !== 'string' || typeof model !== 'string' || !make.trim() || !model.trim()) {
      return res.status(400).json({ error: 'Invalid make or model' });
    }

    try {
      await db.query(
        `
        UPDATE vehicle_type_master
        SET
          make = $1,
          model = $2,
          capacity_tonne = $3,
          category_id = $4,
          architecture_diagram = $5,
          drawings_folder_url = $6,
          updated_at = NOW()
        WHERE vtype_id = $7
        `,
        [
          make.trim(),
          model.trim(),
          capacity_tonne ? parseFloat(capacity_tonne) : null,
          category_id,
          architecture_diagram || null,
          drawings_folder_url || null,
          id
        ]
      );

      res.json({ success: true });
    } catch (err) {
      logger.error(`PUT /api/vehicle-types/${id} error: ${err.message}`);
      if (err.code === '23505') {
        res.status(400).json({ error: 'Make + Model already exists' });
      } else if (err.code === '23503') {
        res.status(400).json({ error: 'Invalid category_id: category does not exist' });
      } else {
        res.status(500).json({ error: 'Server error' });
      }
    }
  }
);

/* ============================================================
   DELETE VEHICLE TYPE
============================================================ */
router.delete(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'delete'),
  async (req, res) => {
    const { id } = req.params;

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid vehicle type id' });
    }

    try {
      const result = await db.query(
        `DELETE FROM vehicle_type_master WHERE vtype_id = $1 RETURNING vtype_id`,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Vehicle type not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error(`DELETE /api/vehicle-types/${id} error: ${err.message}`);
      if (err.code === '23503') {
        res.status(400).json({
          error: 'Cannot delete: this vehicle type is used in one or more vehicles'
        });
      } else {
        res.status(500).json({ error: 'Server error' });
      }
    }
  }
);

module.exports = router;