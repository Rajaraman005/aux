/**
 * World Chat Routes — Public channel visible to all users.
 * GET  /api/world  — fetch recent messages
 * POST /api/world  — send a message (HTTP fallback; WebSocket is preferred)
 */
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const { db } = require("../db/supabase");

// GET /api/world — last 50 messages (paginated by `before` ISO timestamp)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before || null;
    const messages = await db.getWorldMessages(limit, before);
    res.json({ messages });
  } catch (err) {
    console.error("World chat fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch world messages" });
  }
});

// POST /api/world — send a message (HTTP fallback)
router.post("/", authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: "Content is required" });
    }
    if (content.length > 1000) {
      return res
        .status(400)
        .json({ error: "Message too long (max 1000 chars)" });
    }

    const msg = await db.createWorldMessage({
      sender_id: req.user.id,
      sender_name: req.user.name || "Unknown",
      sender_avatar: req.user.name,
      content: content.trim(),
    });
    res.status(201).json({ message: msg });
  } catch (err) {
    console.error("World chat send error:", err.message);
    res.status(500).json({ error: "Failed to send message" });
  }
});

module.exports = router;
