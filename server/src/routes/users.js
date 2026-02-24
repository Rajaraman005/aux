/**
 * User Routes.
 * List, search, profile endpoints + profile update + password change + avatar upload.
 * All endpoints require authentication.
 */
const express = require("express");
const multer = require("multer");
const { db } = require("../db/supabase");
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const { generateAvatarDataUri } = require("../services/avatar");
const { uploadAvatar } = require("../services/cloudinary");
const argon2 = require("argon2");

const router = express.Router();

// ─── Multer Config (memory storage, 5MB limit, images only) ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

// All user routes require auth
router.use(authenticateToken);
router.use(apiLimiter);

/**
 * Helper: Serialize user object for API response.
 * Uses Cloudinary avatar_url if set, otherwise falls back to generated avatar.
 */
function serializeUser(user, opts = {}) {
  const base = {
    id: user.id,
    name: user.name,
    avatarUrl: user.avatar_url || null,
    avatar: generateAvatarDataUri(user.avatar_seed, user.name),
    isPrivate: user.is_private || false,
  };

  if (opts.includeEmail)
    base.email = user.is_private && opts.hidePrivateEmail ? null : user.email;
  if (opts.includePhone) base.phone = user.phone;
  if (opts.includeBio) base.bio = user.bio || null;
  if (opts.includeVerified) base.emailVerified = user.email_verified;
  if (opts.includeSecret) base.secretName = user.secret_name || null;
  if (opts.includeCreatedAt) base.createdAt = user.created_at;

  return base;
}

// ─── GET /api/users — Paginated verified user list ──────────────────────────
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    // Fetch public users
    const users = await db.listVerifiedUsers(limit, offset);

    // ★ Also fetch accepted friends (includes private friends)
    const friends = await db.getFriends(req.user.id);
    const publicIds = new Set(users.map((u) => u.id));
    const privateFriends = friends.filter(
      (f) => !publicIds.has(f.id) && f.id !== req.user.id,
    );

    // Merge: public users + private friends
    const allUsers = [...users, ...privateFriends];

    const enriched = [];
    for (const u of allUsers) {
      if (u.id === req.user.id) continue;

      const entry = serializeUser(u, {
        includeEmail: true,
        hidePrivateEmail: true,
        includeBio: true,
        includeCreatedAt: true,
      });

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

    // ★ Also include private friends whose name matches the search query
    const friends = await db.getFriends(req.user.id);
    const searchIds = new Set(users.map((u) => u.id));
    const queryLower = query.toLowerCase();
    const matchingPrivateFriends = friends.filter(
      (f) =>
        !searchIds.has(f.id) &&
        f.id !== req.user.id &&
        f.name &&
        f.name.toLowerCase().includes(queryLower),
    );

    const allUsers = [...users, ...matchingPrivateFriends];

    const enriched = [];
    for (const u of allUsers) {
      if (u.id === req.user.id) continue;

      const entry = serializeUser(u, {
        includeEmail: true,
        hidePrivateEmail: true,
        includeBio: true,
      });

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

    res.json(
      serializeUser(user, {
        includeEmail: true,
        includePhone: true,
        includeBio: true,
        includeVerified: true,
        includeSecret: true,
        includeCreatedAt: true,
      }),
    );
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

    if (name !== undefined && (!name || name.trim().length < 2)) {
      return res.status(400).json({
        error: "Name must be at least 2 characters",
        code: "VALIDATION_ERROR",
      });
    }

    if (isPrivate === true && !secretName) {
      return res.status(400).json({
        error: "Secret name is required when enabling private mode",
        code: "VALIDATION_ERROR",
      });
    }

    if (secretName !== undefined && secretName && secretName.length < 3) {
      return res.status(400).json({
        error: "Secret name must be at least 3 characters",
        code: "VALIDATION_ERROR",
      });
    }

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
    if (isPrivate === false) updates.secret_name = null;

    const updated = await db.updateUserProfile(req.user.id, updates);

    res.json(
      serializeUser(updated, {
        includeEmail: true,
        includeBio: true,
        includeVerified: true,
        includeSecret: true,
        includeCreatedAt: true,
      }),
    );
  } catch (err) {
    console.error("Update profile error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── POST /api/users/me/avatar — Upload profile picture ─────────────────────
router.post("/me/avatar", upload.single("avatar"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No image file provided",
        code: "VALIDATION_ERROR",
      });
    }

    const { url } = await uploadAvatar(req.file.buffer, req.user.id);

    const updated = await db.updateUserProfile(req.user.id, {
      avatar_url: url,
    });

    console.log(`📸 Avatar uploaded for ${req.user.id}: ${url}`);

    const serialized = serializeUser(updated, {
      includeEmail: true,
      includePhone: true,
      includeBio: true,
      includeVerified: true,
      includeSecret: true,
      includeCreatedAt: true,
    });

    // ★ Real-time broadcast: notify all conversation partners about the new avatar
    try {
      const presence = require("../signaling/presence");
      const conversations = await db.getConversationsForUser(req.user.id);

      const profileUpdate = {
        type: "profile-updated",
        userId: req.user.id,
        avatarUrl: url,
        name: updated.name,
        timestamp: Date.now(),
      };

      // Collect unique partner IDs from all conversations
      const partnerIds = new Set();
      for (const conv of conversations) {
        const participants = await db.getConversationParticipants(conv.id);
        for (const pid of participants) {
          if (pid !== req.user.id) partnerIds.add(pid);
        }
      }

      // Broadcast to all online partners in parallel
      const sendPromises = [...partnerIds].map((partnerId) =>
        presence.sendToUser(partnerId, profileUpdate).catch(() => {}),
      );
      await Promise.all(sendPromises);

      console.log(`📡 Avatar update broadcast to ${partnerIds.size} partners`);
    } catch (broadcastErr) {
      // Non-critical — don't fail the upload if broadcast fails
      console.error("Avatar broadcast error:", broadcastErr.message);
    }

    res.json(serialized);
  } catch (err) {
    console.error("Avatar upload error:", err);

    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "Image must be less than 5MB",
        code: "FILE_TOO_LARGE",
      });
    }

    res
      .status(500)
      .json({ error: "Failed to upload avatar", code: "UPLOAD_ERROR" });
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

    if (user.is_private && req.params.id !== req.user.id) {
      const friends = await db.areFriends(req.user.id, req.params.id);
      if (!friends) {
        return res.json(serializeUser(user, {}));
      }
    }

    res.json(serializeUser(user, { includeCreatedAt: true }));
  } catch (err) {
    console.error("Get user error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

module.exports = router;
