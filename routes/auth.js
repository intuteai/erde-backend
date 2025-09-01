const express = require("express");
const router = express.Router();
const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

// Middleware to authenticate token (assuming it's defined elsewhere)
const authenticateToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access denied" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
};

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  console.log("Route hit with body:", req.body); // Debug log

  if (!email || !password) {
    console.log("Missing credentials:", { email, password }); // Debug log
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    console.log("Attempting login for email:", email); // Debug log
    const user = await User.findByEmail(email);
    if (!user) {
      console.log("User not found for email:", email); // Debug log
      return res.status(401).json({ error: "Invalid credentials" });
    }

    console.log("User found:", user); // Debug log
    const isValid = await bcrypt.compare(password, user.password_hash);
    console.log("Password match result:", isValid); // Debug log
    if (!isValid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      {
        user_id: user.id,
        username: user.username,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "6h" }
    );

    console.log("Login successful, token generated:", token); // Debug log
    res.json({
      role: user.role,
      name: user.username,
      token,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/update-password", authenticateToken, async (req, res) => {
  const { email, newPassword } = req.body;

  console.log("Route hit for update-password with body:", req.body); // Debug log

  if (!email || !newPassword) {
    console.log("Missing fields for password update:", { email, newPassword }); // Debug log
    return res.status(400).json({ error: "Email and new password are required" });
  }

  try {
    console.log("Attempting password update for email:", email); // Debug log
    const user = await User.findByEmail(email);
    if (!user) {
      console.log("User not found for password update:", email); // Debug log
      return res.status(404).json({ error: "User not found" });
    }

    const saltRounds = 6;
    const newHash = await bcrypt.hash(newPassword, saltRounds);

    const updatedUser = await User.updatePassword(email, newHash);
    console.log("Password updated successfully for email:", email, updatedUser); // Debug log
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Password update error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;