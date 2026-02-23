/**
 * World Chat Routes — Public channel visible to all users.
 * GET  /api/world  — fetch recent messages (private users anonymized)
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

    // Anonymize messages from private users
    const anonymized = [];
    for (const msg of messages) {
      // Check if sender is private
      const sender = await db.getUserById(msg.sender_id);
      if (sender && sender.is_private) {
        anonymized.push({
          ...msg,
          sender_name: "Anonymous",
          sender_avatar: "anonymous",
          is_anonymous: true,
        });
      } else {
        anonymized.push(msg);
      }
    }

    res.json({ messages: anonymized });
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

    // Check if sender is private — anonymize if so
    const sender = await db.getUserById(req.user.id);
    const isPrivate = sender && sender.is_private;

    const msg = await db.createWorldMessage({
      sender_id: req.user.id,
      sender_name: isPrivate ? "Anonymous" : req.user.name || "Unknown",
      sender_avatar: isPrivate ? "anonymous" : req.user.name,
      content: content.trim(),
    });

    // Mark as anonymous in the response
    if (isPrivate) {
      msg.is_anonymous = true;
    }

    res.status(201).json({ message: msg });
  } catch (err) {
    console.error("World chat send error:", err.message);
    res.status(500).json({ error: "Failed to send message" });
  }
});

module.exports = router;
