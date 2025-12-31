const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'hmi';

/* ============================================================
   GET ALL HMIs
============================================================ */
router.get(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    try {
      const result = await db.query(`
        SELECT
          hmi_id,
          hmi_make,
          hmi_model,
          serial_number,
          hmi_specs,
          created_at,
          updated_at
        FROM hmi_master
        ORDER BY hmi_make, hmi_model, serial_number
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
   CREATE HMI (ONE ROW = ONE SERIAL)
============================================================ */
router.post(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const { hmi_make, hmi_model, serial_number, hmi_specs } = req.body;

    if (!hmi_make || !hmi_model || !serial_number) {
      return res.status(400).json({
        error: 'hmi_make, hmi_model and serial_number are required',
      });
    }

    try {
      const result = await db.query(
        `
        INSERT INTO hmi_master (
          hmi_make,
          hmi_model,
          serial_number,
          hmi_specs,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING hmi_id
        `,
        [
          hmi_make.trim(),
          hmi_model.trim(),
          serial_number.trim(),
          hmi_specs || null,
          req.user.user_id,
        ]
      );

      res.status(201).json({ hmi_id: result.rows[0].hmi_id });
    } catch (err) {
      logger.error(`POST /hmi error: ${err.message}`);

      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Serial number already exists',
        });
      }

      res.status(500).json({ error: 'Failed to create HMI' });
    }
  }
);

/* ============================================================
   UPDATE HMI (SERIAL EDITABLE BUT UNIQUE)
============================================================ */
router.put(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const allowed = ['hmi_make', 'hmi_model', 'serial_number', 'hmi_specs'];
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
          error: 'Serial number already exists',
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
