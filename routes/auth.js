const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  console.log('Route hit with body:', req.body); // Debug log

  if (!email || !password) {
    console.log('Missing credentials:', { email, password }); // Debug log
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    console.log('Attempting login for email:', email); // Debug log
    const user = await User.findByEmail(email);
    if (!user) {
      console.log('User not found for email:', email); // Debug log
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    console.log('User found:', user); // Debug log
    const isValid = await bcrypt.compare(password, user.password_hash);
    console.log('Password match result:', isValid); // Debug log
    if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      {
        user_id: user.id,
        username: user.username,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: '6h' }
    );

    console.log('Login successful, token generated:', token); // Debug log
    res.json({
      role: user.role,
      name: user.username,
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;