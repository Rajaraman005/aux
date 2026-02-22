/**
 * User Routes.
 * List, search, and profile endpoints.
 * All endpoints require authentication.
 */
const express = require("express");
const { db } = require("../db/supabase");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const { generateAvatarDataUri } = require("../services/avatar");

const router = express.Router();

// All user routes require auth
router.use(authenticateToken);
router.use(apiLimiter);

// ─── GET /api/users — Paginated verified user list ──────────────────────────
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    const users = await db.listVerifiedUsers(limit, offset);

    // Enrich with avatar data URIs
    const enriched = users
      .filter((u) => u.id !== req.user.id) // Exclude self
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        avatar: generateAvatarDataUri(u.avatar_seed, u.name),
        createdAt: u.created_at,
      }));

    res.json({ users: enriched, total: enriched.length, limit, offset });
  } catch (err) {
    console.error("List users error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── GET /api/users/search?q= — Search users ───────────────────────────────
router.get("/search", async (req, res) => {
  try {
    const query = (req.query.q || "").trim();
    if (query.length < 2) {
      return res
        .status(400)
        .json({
          error: "Search query must be at least 2 characters",
          code: "VALIDATION_ERROR",
        });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    const users = await db.searchUsers(query, limit, offset);

    const enriched = users
      .filter((u) => u.id !== req.user.id)
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        avatar: generateAvatarDataUri(u.avatar_seed, u.name),
      }));

    res.json({ users: enriched, query });
  } catch (err) {
    console.error("Search users error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── GET /api/users/me — Current user profile ──────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res
        .status(404)
        .json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: generateAvatarDataUri(user.avatar_seed, user.name),
      emailVerified: user.email_verified,
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error("Get profile error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── GET /api/users/:id — User profile by ID ───────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const user = await db.getUserById(req.params.id);
    if (!user) {
      return res
        .status(404)
        .json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

    res.json({
      id: user.id,
      name: user.name,
      avatar: generateAvatarDataUri(user.avatar_seed, user.name),
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error("Get user error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

module.exports = router;
