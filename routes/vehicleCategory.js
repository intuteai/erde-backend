// routes/vehicleCategory.js
const express = require('express');
const db = require('../config/postgres');
const authenticateToken = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const logger = require('../utils/logger');

const router = express.Router();
const MODULE = 'vehicle_categories';

/* ============================================================
   GET ALL VEHICLE CATEGORIES
   ============================================================ */
router.get(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    try {
      const result = await db.query(`
        SELECT
          category_id,
          category_name,
          description,
          created_at
        FROM vehicle_categories
        ORDER BY category_name
      `);

      res.json(result.rows);
    } catch (err) {
      logger.error(`GET /vehicle-categories error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   GET SINGLE VEHICLE CATEGORY
   ============================================================ */
router.get(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'read'),
  async (req, res) => {
    const { id } = req.params;

    try {
      const result = await db.query(
        `
        SELECT
          category_id,
          category_name,
          description,
          created_at
        FROM vehicle_categories
        WHERE category_id = $1
        `,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      logger.error(`GET /vehicle-categories/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   CREATE VEHICLE CATEGORY
   ============================================================ */
router.post(
  '/',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const { category_name, description } = req.body;

    if (!category_name || !category_name.trim()) {
      return res.status(400).json({
        error: 'category_name is required'
      });
    }

    try {
      const result = await db.query(
        `
        INSERT INTO vehicle_categories (
          category_name,
          description
        )
        VALUES ($1, $2)
        RETURNING category_id
        `,
        [
          category_name.trim(),
          description || null
        ]
      );

      logger.info(
        `Vehicle category created: ${category_name.trim()} by user ${req.user.user_id}`
      );

      res.status(201).json({
        category_id: result.rows[0].category_id
      });
    } catch (err) {
      logger.error(`POST /vehicle-categories error: ${err.message}`);

      if (err.code === '23505') {
        return res.status(400).json({
          error: 'Category already exists'
        });
      }

      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   UPDATE VEHICLE CATEGORY
   ============================================================ */
router.put(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'write'),
  async (req, res) => {
    const { id } = req.params;
    const { category_name, description } = req.body;

    if (!category_name || !category_name.trim()) {
      return res.status(400).json({
        error: 'category_name is required'
      });
    }

    try {
      const result = await db.query(
        `
        UPDATE vehicle_categories
        SET
          category_name = $1,
          description = $2
        WHERE category_id = $3
        RETURNING category_id
        `,
        [
          category_name.trim(),
          description || null,
          id
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      logger.info(`Vehicle category updated: ${id}`);
      res.json({ success: true });
    } catch (err) {
      logger.error(`PUT /vehicle-categories/${id} error: ${err.message}`);

      if (err.code === '23505') {
        return res.status(400).json({
          error: 'Category already exists'
        });
      }

      res.status(500).json({ error: 'Server error' });
    }
  }
);

/* ============================================================
   DELETE VEHICLE CATEGORY (FK SAFE)
   ============================================================ */
router.delete(
  '/:id',
  authenticateToken,
  checkPermission(MODULE, 'delete'),
  async (req, res) => {
    const { id } = req.params;

    try {
      // Check usage in vehicle_type_master
      const usage = await db.query(
        `
        SELECT 1
        FROM vehicle_type_master
        WHERE category_id = $1
        LIMIT 1
        `,
        [id]
      );

      if (usage.rowCount > 0) {
        return res.status(400).json({
          error: 'Cannot delete category: used in vehicle types'
        });
      }

      const result = await db.query(
        `
        DELETE FROM vehicle_categories
        WHERE category_id = $1
        RETURNING category_id
        `,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      logger.info(`Vehicle category deleted: ${id}`);
      res.json({ success: true });
    } catch (err) {
      logger.error(`DELETE /vehicle-categories/${id} error: ${err.message}`);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
