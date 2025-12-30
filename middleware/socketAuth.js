const jwt = require('jsonwebtoken');

module.exports = (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Unauthorized'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.user_id || !decoded.role) {
      return next(new Error('Invalid token'));
    }

    socket.user = decoded; // same as req.user
    next();
  } catch (err) {
    next(new Error('Unauthorized'));
  }
};
