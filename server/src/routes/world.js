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
    const {
      content,
      media_url,
      media_type,
      media_thumbnail,
      media_width,
      media_height,
      media_duration,
      media_size,
      media_mime_type,
    } = req.body;

    const hasContent = content && content.trim().length > 0;
    const hasMedia = media_url && media_type;

    if (!hasContent && !hasMedia) {
      return res.status(400).json({ error: "Content or media is required" });
    }
    if (content && content.length > 1000) {
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
      content: hasContent ? content.trim() : null,
      media_url: media_url || null,
      media_type: media_type || null,
      media_thumbnail: media_thumbnail || null,
      media_width: media_width || null,
      media_height: media_height || null,
      media_duration: media_duration || null,
      media_size: media_size || null,
      media_mime_type: media_mime_type || null,
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
