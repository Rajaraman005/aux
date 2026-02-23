/**
 * Notification Routes — FAANG-grade notification center.
 * GET  /api/notifications         — list with cursor pagination + unread_count
 * GET  /api/notifications/count   — unread badge count
 * PUT  /api/notifications/read-all — mark all as read
 * PUT  /api/notifications/:id/read — mark one as read
 *
 * Security: all routes validate user_id from JWT, never from request params.
 */
const express = require("express");
const { db } = require("../db/supabase");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

router.use(authenticateToken);
router.use(apiLimiter);

// ─── GET /api/notifications — Cursor-paginated list ─────────────────────────
router.get("/", async (req, res) => {
  try {
    const unreadOnly = req.query.unread === "true";
    const cursor = req.query.cursor || null;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const result = await db.getNotifications(req.user.id, {
      unreadOnly,
      cursor,
      limit,
    });

    res.json(result);
  } catch (err) {
    console.error("Get notifications error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch notifications", code: "SERVER_ERROR" });
  }
});

// ─── GET /api/notifications/count — Unread badge count ──────────────────────
router.get("/count", async (req, res) => {
  try {
    const unread_count = await db.getUnreadCount(req.user.id);
    res.json({ unread_count });
  } catch (err) {
    console.error("Get unread count error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to get count", code: "SERVER_ERROR" });
  }
});

// ─── PUT /api/notifications/read-all — Mark all as read ─────────────────────
router.put("/read-all", async (req, res) => {
  try {
    await db.markAllRead(req.user.id);
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("Mark all read error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to mark all read", code: "SERVER_ERROR" });
  }
});

// ─── PUT /api/notifications/:id/read — Mark one as read ─────────────────────
router.put("/:id/read", async (req, res) => {
  try {
    const result = await db.markNotificationRead(req.params.id, req.user.id);
    if (!result) {
      return res
        .status(404)
        .json({ error: "Notification not found", code: "NOT_FOUND" });
    }
    res.json({ notification: result });
  } catch (err) {
    console.error("Mark read error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to mark read", code: "SERVER_ERROR" });
  }
});

module.exports = router;
