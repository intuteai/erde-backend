const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'hmi';

/* =========================
   GET ALL HMIs
========================= */
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
          hmi_specs,
          created_at
        FROM hmi_master
        ORDER BY hmi_make, hmi_model
      `);
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /hmi error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* =========================
   GET HMI BY ID
========================= */
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

/* =========================
   CREATE HMI
========================= */
router.post(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const { hmi_make, hmi_model, hmi_specs } = req.body;

    if (!hmi_make || !hmi_model) {
      return res.status(400).json({ error: 'hmi_make and hmi_model required' });
    }

    try {
      const result = await db.query(
        `
        INSERT INTO hmi_master
          (hmi_make, hmi_model, hmi_specs, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING hmi_id
        `,
        [hmi_make, hmi_model, hmi_specs || null, req.user.user_id]
      );

      res.status(201).json({ hmi_id: result.rows[0].hmi_id });
    } catch (err) {
      logger.error(`POST /hmi error: ${err.message}`);
      res.status(400).json({ error: 'HMI already exists' });
    }
  }
);

/* =========================
   UPDATE HMI
========================= */
router.put(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const allowed = ['hmi_make', 'hmi_model', 'hmi_specs'];
    const updates = [];
    const values = [];
    let i = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${i}`);
        values.push(req.body[key]);
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
        SET ${updates.join(', ')}, updated_at = NOW()
        WHERE hmi_id = $${i}
        `,
        values
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: 'HMI not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error(`PUT /hmi/${req.params.id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* =========================
   DELETE HMI
========================= */
router.delete(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'delete'),
  async (req, res) => {
    try {
      await db.query(
        `DELETE FROM hmi_master WHERE hmi_id = $1`,
        [req.params.id]
      );
      res.json({ success: true });
    } catch (err) {
      logger.error(`DELETE /hmi/${req.params.id} error: ${err.message}`);
      res.status(400).json({ error: 'HMI in use by vehicle_master' });
    }
  }
);

module.exports = router;
