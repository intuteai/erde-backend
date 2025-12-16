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
          v.capacity_kwh,
          v.motor_specs,
          v.category_id,
          c.category_name,
          v.architecture_diagram,
          v.drawings_folder_url,
          v.created_at
        FROM vehicle_type_master v
        LEFT JOIN vehicle_categories c
          ON c.category_id = v.category_id
        ORDER BY c.category_name, v.make, v.model
      `);

      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /vehicle-types error: ${err.message}`);
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
      capacity_kwh,
      motor_specs,
      category_id,
      architecture_diagram,
      drawings_folder_url
    } = req.body;

    if (!make || !model || !category_id) {
      return res.status(400).json({
        error: 'make, model and category_id are required'
      });
    }

    try {
      const result = await db.query(
        `
        INSERT INTO vehicle_type_master (
          make,
          model,
          capacity_kwh,
          motor_specs,
          category_id,
          architecture_diagram,
          drawings_folder_url,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING vtype_id
        `,
        [
          make.trim(),
          model.trim(),
          capacity_kwh || null,
          motor_specs || null,
          category_id,
          architecture_diagram || null,
          drawings_folder_url || null,
          req.user.user_id
        ]
      );

      res.status(201).json({ vtype_id: result.rows[0].vtype_id });
    } catch (err) {
      logger.error(`POST /vehicle-types error: ${err.message}`);
      if (err.code === '23505') {
        res.status(400).json({ error: 'Make + Model already exists' });
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
      capacity_kwh,
      motor_specs,
      category_id,
      architecture_diagram,
      drawings_folder_url
    } = req.body;

    try {
      const result = await db.query(
        `
        UPDATE vehicle_type_master
        SET
          make = $1,
          model = $2,
          capacity_kwh = $3,
          motor_specs = $4,
          category_id = $5,
          architecture_diagram = $6,
          drawings_folder_url = $7,
          updated_at = NOW()
        WHERE vtype_id = $8
        RETURNING vtype_id
        `,
        [
          make.trim(),
          model.trim(),
          capacity_kwh || null,
          motor_specs || null,
          category_id,
          architecture_diagram || null,
          drawings_folder_url || null,
          id
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error(`PUT /vehicle-types/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
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
    try {
      const result = await db.query(
        `DELETE FROM vehicle_type_master WHERE vtype_id = $1 RETURNING vtype_id`,
        [req.params.id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error(`DELETE /vehicle-types error: ${err.message}`);
      res.status(400).json({
        error: 'Cannot delete: used in vehicle_master'
      });
    }
  }
);

module.exports = router;
