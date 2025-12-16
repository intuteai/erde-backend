const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'vcu';

/* =========================
   GET ALL VCUs
========================= */
router.get(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    try {
      const result = await db.query(`
        SELECT
          vcu_id,
          vcu_make,
          vcu_model,
          vcu_specs,
          created_at
        FROM vcu_master
        ORDER BY vcu_make, vcu_model
      `);
      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /vcu error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* =========================
   GET VCU BY ID
========================= */
router.get(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    try {
      const result = await db.query(
        `SELECT * FROM vcu_master WHERE vcu_id = $1`,
        [req.params.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: 'VCU not found' });
      }
      res.json(result.rows[0]);
    } catch (err) {
      logger.error(`GET /vcu/${req.params.id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* =========================
   CREATE VCU
========================= */
router.post(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const { vcu_make, vcu_model, vcu_specs } = req.body;

    if (!vcu_make || !vcu_model) {
      return res.status(400).json({ error: 'vcu_make and vcu_model required' });
    }

    try {
      const result = await db.query(
        `
        INSERT INTO vcu_master
          (vcu_make, vcu_model, vcu_specs, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING vcu_id
        `,
        [vcu_make, vcu_model, vcu_specs || null, req.user.user_id]
      );

      res.status(201).json({ vcu_id: result.rows[0].vcu_id });
    } catch (err) {
      logger.error(`POST /vcu error: ${err.message}`);
      res.status(400).json({ error: 'VCU already exists' });
    }
  }
);

/* =========================
   UPDATE VCU
========================= */
router.put(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const allowed = ['vcu_make', 'vcu_model', 'vcu_specs'];
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
        UPDATE vcu_master
        SET ${updates.join(', ')}, updated_at = NOW()
        WHERE vcu_id = $${i}
        `,
        values
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: 'VCU not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error(`PUT /vcu/${req.params.id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* =========================
   DELETE VCU
========================= */
router.delete(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'delete'),
  async (req, res) => {
    try {
      await db.query(
        `DELETE FROM vcu_master WHERE vcu_id = $1`,
        [req.params.id]
      );
      res.json({ success: true });
    } catch (err) {
      logger.error(`DELETE /vcu/${req.params.id} error: ${err.message}`);
      res.status(400).json({ error: 'VCU in use by vehicle_master' });
    }
  }
);

module.exports = router;
