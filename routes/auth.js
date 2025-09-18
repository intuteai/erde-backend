const express = require('express');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    logger.error('Login failed: Missing username or password');
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (username === 'admin@intuteai.in' && password === 'password123') {
    const user = {
      username,
      id: 'mock_user_id',
      role: 'admin',
      name: 'Admin User',
      email: username,
    };
    try {
      const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' });
      logger.info(`Login successful for ${username}`);
      res.json({ token, role: user.role, name: user.name, email: user.email });
    } catch (err) {
      logger.error(`JWT generation error for ${username}:`, err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  } else {
    logger.error(`Login failed for ${username}: Invalid credentials`);
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

module.exports = router;