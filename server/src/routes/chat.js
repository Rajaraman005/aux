/**
 * Chat Routes.
 * Conversations: list, create, messages, read receipts.
 * All endpoints require authentication.
 */
const express = require("express");
const { db } = require("../db/supabase");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

// All chat routes require auth
router.use(authenticateToken);
router.use(apiLimiter);

// ─── GET /api/conversations — List conversations for authenticated user ─────
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const conversations = await db.getConversationsForUser(
      req.user.id,
      limit,
      offset,
    );
    res.json({ conversations });
  } catch (err) {
    console.error("List conversations error:", err);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// ─── POST /api/conversations — Create or get existing conversation ──────────
router.post("/", async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ error: "targetUserId is required" });
    }
    if (targetUserId === req.user.id) {
      return res
        .status(400)
        .json({ error: "Cannot create conversation with yourself" });
    }

    // Check if target user exists
    const targetUser = await db.getUserById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // ─── Privacy Guard: Private users can only be messaged by friends ────
    if (targetUser.is_private) {
      const friends = await db.areFriends(req.user.id, targetUserId);
      if (!friends) {
        return res.status(403).json({
          error:
            "This user has a private account. Send a friend request first.",
          code: "PRIVATE_USER",
        });
      }
    }

    // Check for existing conversation
    const existingConvId = await db.getConversationBetweenUsers(
      req.user.id,
      targetUserId,
    );
    if (existingConvId) {
      return res.json({ conversation: { id: existingConvId, isNew: false } });
    }

    // Create new conversation
    const conv = await db.createConversation([req.user.id, targetUserId]);
    res.status(201).json({ conversation: { ...conv, isNew: true } });
  } catch (err) {
    console.error("Create conversation error:", err);
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

// ─── GET /api/conversations/:id/messages — Paginated messages ───────────────
router.get("/:id/messages", async (req, res) => {
  try {
    const conversationId = req.params.id;

    // Verify user is a participant
    const isParticipant = await db.isConversationParticipant(
      conversationId,
      req.user.id,
    );
    if (!isParticipant) {
      return res.status(403).json({ error: "Not a participant" });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const messages = await db.getMessages(conversationId, limit, offset);
    res.json({ messages });
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ─── POST /api/conversations/:id/messages — Send message (HTTP fallback) ────
router.post("/:id/messages", async (req, res) => {
  try {
    const conversationId = req.params.id;
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
      return res
        .status(400)
        .json({ error: "Message content or media is required" });
    }
    if (content && content.length > 5000) {
      return res.status(400).json({ error: "Message too long (max 5000)" });
    }

    // Verify user is a participant
    const isParticipant = await db.isConversationParticipant(
      conversationId,
      req.user.id,
    );
    if (!isParticipant) {
      return res.status(403).json({ error: "Not a participant" });
    }

    const message = await db.createMessage({
      conversation_id: conversationId,
      sender_id: req.user.id,
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

    res.status(201).json({ message });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ─── POST /api/conversations/:id/read — Mark messages as read ───────────────
router.post("/:id/read", async (req, res) => {
  try {
    const conversationId = req.params.id;

    const isParticipant = await db.isConversationParticipant(
      conversationId,
      req.user.id,
    );
    if (!isParticipant) {
      return res.status(403).json({ error: "Not a participant" });
    }

    await db.markMessagesRead(conversationId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: "Failed to mark messages as read" });
  }
});

module.exports = router;
