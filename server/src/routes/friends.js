/**
 * Friend Request Routes — Enterprise-grade friend system.
 * POST /api/friends/request      — Send friend request
 * PUT  /api/friends/:requestId   — Accept/reject request
 * GET  /api/friends/requests     — List pending incoming requests
 * GET  /api/friends              — List accepted friends
 */
const express = require("express");
const { db } = require("../db/supabase");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const { generateAvatarDataUri } = require("../services/avatar");
const presence = require("../signaling/presence");

const router = express.Router();

// All friend routes require auth
router.use(authenticateToken);
router.use(apiLimiter);

// ─── POST /api/friends/request — Send friend request ────────────────────────
router.post("/request", async (req, res) => {
  try {
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res
        .status(400)
        .json({ error: "targetUserId is required", code: "VALIDATION_ERROR" });
    }

    if (targetUserId === req.user.id) {
      return res.status(400).json({
        error: "Cannot send request to yourself",
        code: "VALIDATION_ERROR",
      });
    }

    // Verify target user exists
    const targetUser = await db.getUserById(targetUserId);
    if (!targetUser) {
      return res
        .status(404)
        .json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

    const result = await db.sendFriendRequest(req.user.id, targetUserId);

    if (result.alreadyFriends) {
      return res.json({ message: "Already friends", status: "accepted" });
    }
    if (result.alreadyPending) {
      return res.json({ message: "Request already sent", status: "pending" });
    }

    res.status(201).json({
      message: "Friend request sent",
      request: result,
    });

    // ── Create notification + real-time push ──────────────────────────
    try {
      const sender = await db.getUserById(req.user.id);
      const senderName = sender?.name || "Someone";
      const notification = await db.createNotification({
        user_id: targetUserId,
        type: "friend_request",
        title: "New Friend Request",
        body: `${senderName} sent you a friend request`,
        data: {
          sender_id: req.user.id,
          sender_name: senderName,
          request_id: result.id,
        },
        priority: 1,
        group_key: `friend_request:${req.user.id}:${targetUserId}`,
      });
      // Push via WebSocket (fire-and-forget)
      presence
        .sendToUser(targetUserId, {
          type: "notification:new",
          notification,
        })
        .catch(() => {});
    } catch (notifErr) {
      console.error(
        "Failed to create friend request notification:",
        notifErr.message,
      );
    }
  } catch (err) {
    console.error("Send friend request error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── DELETE /api/friends/request/:targetUserId — Withdraw sent request ───────
router.delete("/request/:targetUserId", async (req, res) => {
  try {
    const { targetUserId } = req.params;

    const result = await db.withdrawFriendRequest(req.user.id, targetUserId);

    if (!result) {
      return res.status(404).json({
        error: "No pending request found to withdraw",
        code: "NOT_FOUND",
      });
    }

    res.json({ message: "Friend request withdrawn", request: result });
  } catch (err) {
    console.error("Withdraw friend request error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── PUT /api/friends/:requestId — Accept or reject ─────────────────────────
router.put("/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action } = req.body;

    if (!action || !["accept", "reject"].includes(action)) {
      return res.status(400).json({
        error: "action must be 'accept' or 'reject'",
        code: "VALIDATION_ERROR",
      });
    }

    const status = action === "accept" ? "accepted" : "rejected";
    const result = await db.respondFriendRequest(
      requestId,
      req.user.id,
      status,
    );

    if (!result) {
      return res
        .status(404)
        .json({ error: "Request not found", code: "NOT_FOUND" });
    }

    res.json({
      message: `Friend request ${status}`,
      request: result,
    });
  } catch (err) {
    console.error("Respond friend request error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── GET /api/friends/requests — Pending incoming requests ──────────────────
router.get("/requests", async (req, res) => {
  try {
    const requests = await db.getFriendRequests(req.user.id);

    // Enrich with avatars
    const enriched = requests.map((r) => ({
      ...r,
      sender_avatar_uri: generateAvatarDataUri(r.sender_avatar, r.sender_name),
    }));

    res.json({ requests: enriched });
  } catch (err) {
    console.error("Get friend requests error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── GET /api/friends — List accepted friends ───────────────────────────────
router.get("/", async (req, res) => {
  try {
    const friends = await db.getFriends(req.user.id);

    const enriched = friends.map((f) => ({
      id: f.id,
      name: f.name,
      avatar: generateAvatarDataUri(f.avatar_seed, f.name),
    }));

    res.json({ friends: enriched });
  } catch (err) {
    console.error("Get friends error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

module.exports = router;
