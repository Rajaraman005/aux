/**
 * User Routes.
 * List, search, profile endpoints + profile update + password change.
 * All endpoints require authentication.
 */
const express = require("express");
const { db } = require("../db/supabase");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const { generateAvatarDataUri } = require("../services/avatar");
const argon2 = require("argon2");

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

    // Enrich with avatar data URIs + friend status
    const enriched = [];
    for (const u of users) {
      if (u.id === req.user.id) continue; // Exclude self

      const entry = {
        id: u.id,
        name: u.name,
        email: u.is_private ? null : u.email,
        bio: u.bio || null,
        avatar: generateAvatarDataUri(u.avatar_seed, u.name),
        isPrivate: u.is_private || false,
        createdAt: u.created_at,
      };

      // Include friend request status for all users
      const reqStatus = await db.getFriendRequestStatus(req.user.id, u.id);
      entry.friendStatus = reqStatus ? reqStatus.status : null;
      entry.friendRequestId = reqStatus ? reqStatus.id : null;
      if (reqStatus) {
        entry.friendRequestDirection =
          reqStatus.sender_id === req.user.id ? "sent" : "received";
      }

      enriched.push(entry);
    }

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
      return res.status(400).json({
        error: "Search query must be at least 2 characters",
        code: "VALIDATION_ERROR",
      });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    const users = await db.searchUsers(query, limit, offset);

    // Enrich with avatar + friend request status
    const enriched = [];
    for (const u of users) {
      if (u.id === req.user.id) continue; // Exclude self

      const entry = {
        id: u.id,
        name: u.name,
        email: u.is_private ? null : u.email, // Hide email for private users
        bio: u.bio || null,
        avatar: generateAvatarDataUri(u.avatar_seed, u.name),
        isPrivate: u.is_private || false,
      };

      // Include friend request status for all users
      const reqStatus = await db.getFriendRequestStatus(req.user.id, u.id);
      entry.friendStatus = reqStatus ? reqStatus.status : null;
      entry.friendRequestId = reqStatus ? reqStatus.id : null;
      if (reqStatus) {
        entry.friendRequestDirection =
          reqStatus.sender_id === req.user.id ? "sent" : "received";
      }

      enriched.push(entry);
    }

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
      phone: user.phone,
      bio: user.bio || null,
      avatar: generateAvatarDataUri(user.avatar_seed, user.name),
      emailVerified: user.email_verified,
      isPrivate: user.is_private || false,
      secretName: user.secret_name || null,
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error("Get profile error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── PUT /api/users/me — Update profile ─────────────────────────────────────
router.put("/me", async (req, res) => {
  try {
    const { name, bio, isPrivate, secretName } = req.body;

    // Validate name
    if (name !== undefined && (!name || name.trim().length < 2)) {
      return res.status(400).json({
        error: "Name must be at least 2 characters",
        code: "VALIDATION_ERROR",
      });
    }

    // If enabling private mode, secret_name is required
    if (isPrivate === true && !secretName) {
      return res.status(400).json({
        error: "Secret name is required when enabling private mode",
        code: "VALIDATION_ERROR",
      });
    }

    // Validate secret_name length
    if (secretName !== undefined && secretName && secretName.length < 3) {
      return res.status(400).json({
        error: "Secret name must be at least 3 characters",
        code: "VALIDATION_ERROR",
      });
    }

    // Check secret_name uniqueness
    if (secretName) {
      const existing = await db.getUserBySecretName(secretName);
      if (existing && existing.id !== req.user.id) {
        return res.status(409).json({
          error: "This secret name is already taken",
          code: "SECRET_NAME_TAKEN",
        });
      }
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (bio !== undefined) updates.bio = bio;
    if (isPrivate !== undefined) updates.is_private = isPrivate;
    if (secretName !== undefined) updates.secret_name = secretName;
    // If disabling private mode, clear secret_name
    if (isPrivate === false) updates.secret_name = null;

    const updated = await db.updateUserProfile(req.user.id, updates);

    res.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      bio: updated.bio || null,
      avatar: generateAvatarDataUri(updated.avatar_seed, updated.name),
      emailVerified: updated.email_verified,
      isPrivate: updated.is_private || false,
      secretName: updated.secret_name || null,
      createdAt: updated.created_at,
    });
  } catch (err) {
    console.error("Update profile error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── PUT /api/users/me/password — Change password ───────────────────────────
router.put("/me/password", async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        error: "Current password, new password, and confirmation are required",
        code: "VALIDATION_ERROR",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: "New password must be at least 8 characters",
        code: "VALIDATION_ERROR",
      });
    }

    if (newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ error: "Passwords do not match", code: "VALIDATION_ERROR" });
    }

    // Verify current password
    const user = await db.getUserWithPassword(req.user.id);
    if (!user) {
      return res
        .status(404)
        .json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

    const validPassword = await argon2.verify(
      user.password_hash,
      currentPassword,
    );
    if (!validPassword) {
      return res.status(401).json({
        error: "Current password is incorrect",
        code: "INVALID_PASSWORD",
      });
    }

    // Hash new password
    const newHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    await db.updateUserPassword(req.user.id, newHash);

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Change password error:", err);
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

    // If private and not friends, return limited info
    if (user.is_private && req.params.id !== req.user.id) {
      const friends = await db.areFriends(req.user.id, req.params.id);
      if (!friends) {
        return res.json({
          id: user.id,
          name: user.name,
          avatar: generateAvatarDataUri(user.avatar_seed, user.name),
          isPrivate: true,
          limited: true,
        });
      }
    }

    res.json({
      id: user.id,
      name: user.name,
      avatar: generateAvatarDataUri(user.avatar_seed, user.name),
      isPrivate: user.is_private || false,
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
