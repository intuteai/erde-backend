const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'hmi';

/* ============================================================
   GET ALL HMIs – Enhanced with assignment status
   (Shows complete list for HMI master page + assignment info for Vehicle Master)
============================================================ */
router.get(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    try {
      const result = await db.query(`
        SELECT
          h.hmi_id,
          h.hmi_make,
          h.hmi_model,
          h.imei_number,              -- ← Using the renamed column
          h.hmi_specs,
          h.created_at,
          h.updated_at,
          -- Assignment status fields (used by Vehicle Master for filtering)
          CASE 
            WHEN vm.vehicle_master_id IS NOT NULL THEN true 
            ELSE false 
          END AS is_assigned,
          vm.vehicle_unique_id AS assigned_vehicle_unique_id
        FROM hmi_master h
        LEFT JOIN vehicle_master vm ON vm.hmi_id = h.hmi_id
        ORDER BY h.hmi_make, h.hmi_model, h.imei_number
      `);

      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /hmi error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET HMI BY ID
============================================================ */
router.get(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    try {
      const result = await db.query(
        `SELECT * FROM hmi_master WHERE hmi_id = $1`,
        [req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'HMI not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      logger.error(`GET /hmi/${req.params.id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   CREATE HMI (ONE ROW = ONE IMEI)
============================================================ */
router.post(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const { hmi_make, hmi_model, imei_number, hmi_specs } = req.body;

    if (!hmi_make || !hmi_model || !imei_number) {
      return res.status(400).json({
        error: 'hmi_make, hmi_model and imei_number are required',
      });
    }

    try {
      const result = await db.query(
        `
        INSERT INTO hmi_master (
          hmi_make,
          hmi_model,
          imei_number,              -- ← Updated column name
          hmi_specs,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING hmi_id
        `,
        [
          hmi_make.trim(),
          hmi_model.trim(),
          imei_number.trim(),
          hmi_specs || null,
          req.user.user_id,
        ]
      );

      res.status(201).json({ hmi_id: result.rows[0].hmi_id });
    } catch (err) {
      logger.error(`POST /hmi error: ${err.message}`);

      if (err.code === '23505') {
        return res.status(409).json({
          error: 'IMEI number already exists',
        });
      }

      res.status(500).json({ error: 'Failed to create HMI' });
    }
  }
);

/* ============================================================
   UPDATE HMI (IMEI EDITABLE BUT UNIQUE)
============================================================ */
router.put(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const allowed = ['hmi_make', 'hmi_model', 'imei_number', 'hmi_specs'];
    const updates = [];
    const values = [];
    let i = 1;

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(req.body[field]?.trim?.() ?? req.body[field]);
        i++;
      }
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);

    try {
      const result = await db.query(
        `
        UPDATE hmi_master
        SET ${updates.join(', ')},
            updated_at = NOW()
        WHERE hmi_id = $${i}
        RETURNING hmi_id
        `,
        values
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: 'HMI not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error(`PUT /hmi/${req.params.id} error: ${err.message}`);

      if (err.code === '23505') {
        return res.status(409).json({
          error: 'IMEI number already exists',
        });
      }

      res.status(500).json({ error: 'Update failed' });
    }
  }
);

/* ============================================================
   DELETE HMI
============================================================ */
router.delete(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'delete'),
  async (req, res) => {
    try {
      const result = await db.query(
        `DELETE FROM hmi_master WHERE hmi_id = $1`,
        [req.params.id]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: 'HMI not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error(`DELETE /hmi/${req.params.id} error: ${err.message}`);

      if (err.code === '23503') {
        return res.status(400).json({
          error: 'Cannot delete: HMI is used in vehicle_master',
        });
      }

      res.status(500).json({ error: 'Delete failed' });
    }
  }
);

module.exports = router;