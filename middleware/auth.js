// middleware/auth.js
const jwt = require('jsonwebtoken');
require('dotenv').config();

function authenticateToken(req, res, next) {
  let token = null;

  // 1. Primary: Authorization header (used by fetch, Axios, etc.)
  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.replace('Bearer ', '').trim();
  }

  // 2. Fallback: Query parameter (required for native EventSource / SSE)
  if (!token && req.query.token) {
    token = typeof req.query.token === 'string' ? req.query.token.trim() : null;
  }

  // 3. If still no token → reject
  if (!token) {
    return res
      .status(401)
      .json({ error: 'Authorization token missing or malformed' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🔐 HARDENING — ensure required fields exist
    if (!decoded.user_id || !decoded.role) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.warn('JWT verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authenticateToken;