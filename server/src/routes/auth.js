/**
 * Auth Routes — FAANG-Grade Security.
 * Signup → Email Verify → Login → Token Refresh → Logout
 * Features: Argon2 hashing, refresh token rotation, device binding, abuse detection.
 */
const express = require("express");
const argon2 = require("argon2");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { db } = require("../db/supabase");
const { generateTokenPair, authenticateToken } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiter");
const {
  abuseGuard,
  recordFailure,
  resetFailures,
} = require("../middleware/abuse");
const { generateCode, sendVerificationEmail } = require("../services/email");
const metrics = require("../services/metrics");

const router = express.Router();

// ─── Input Validation Helpers ────────────────────────────────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?[\d\s\-()]{7,20}$/;
const PASSWORD_MIN = 8;

function validateSignupInput(body) {
  const errors = [];
  if (!body.name || body.name.trim().length < 2)
    errors.push("Name must be at least 2 characters");
  if (!body.email || !EMAIL_REGEX.test(body.email))
    errors.push("Valid email is required");
  if (!body.phone || !PHONE_REGEX.test(body.phone))
    errors.push("Valid phone number is required");
  if (!body.password || body.password.length < PASSWORD_MIN)
    errors.push(`Password must be at least ${PASSWORD_MIN} characters`);
  if (body.password !== body.confirmPassword)
    errors.push("Passwords do not match");
  return errors;
}

// ─── POST /api/auth/signup ──────────────────────────────────────────────────
router.post(
  "/signup",
  authLimiter,
  abuseGuard("failed_login"),
  async (req, res) => {
    try {
      const { name, email, phone, password, confirmPassword } = req.body;

      // Validate input
      const errors = validateSignupInput({
        name,
        email,
        phone,
        password,
        confirmPassword,
      });
      if (errors.length > 0) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors,
          code: "VALIDATION_ERROR",
        });
      }

      // Check for existing user
      const existing = await db.getUserByEmail(email.toLowerCase());
      if (existing) {
        metrics.authAttempts.inc({ action: "signup", result: "duplicate" });
        return res.status(409).json({
          error: "An account with this email already exists",
          code: "EMAIL_EXISTS",
        });
      }

      // Hash password with Argon2id (memory-hard, GPU-resistant)
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536, // 64 MB
        timeCost: 3,
        parallelism: 4,
      });

      // Create user
      const userId = uuidv4();
      const avatarSeed = uuidv4();
      const user = await db.createUser({
        id: userId,
        name: name.trim(),
        email: email.toLowerCase().trim(),
        phone: phone.trim(),
        password_hash: passwordHash,
        avatar_seed: avatarSeed,
      });

      // Generate verification code (10 min TTL)
      const code = generateCode();
      await db.createVerificationCode({
        id: uuidv4(),
        user_id: userId,
        code,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

      // Send verification email
      await sendVerificationEmail(email, name, code);

      metrics.authAttempts.inc({ action: "signup", result: "success" });

      res.status(201).json({
        message: "Account created. Please verify your email.",
        userId,
        requiresVerification: true,
      });
    } catch (err) {
      console.error("Signup error:", err);
      metrics.authAttempts.inc({ action: "signup", result: "error" });
      res
        .status(500)
        .json({ error: "Internal server error", code: "SERVER_ERROR" });
    }
  },
);

// ─── POST /api/auth/verify ──────────────────────────────────────────────────
router.post("/verify", authLimiter, async (req, res) => {
  try {
    const { userId, code } = req.body;

    if (!userId || !code || code.length !== 6) {
      return res.status(400).json({
        error: "Valid userId and 6-digit code are required",
        code: "VALIDATION_ERROR",
      });
    }

    const verification = await db.getVerificationCode(userId, code);
    if (!verification) {
      await recordFailure(req.ip, "failed_login", userId);
      return res.status(400).json({
        error: "Invalid or expired verification code",
        code: "INVALID_CODE",
      });
    }

    // Mark code as used + verify email
    await db.markVerificationCodeUsed(verification.id);
    await db.verifyUserEmail(userId);

    resetFailures(req.ip, "failed_login");

    // Auto-login: generate tokens so user goes directly into the app
    const user = await db.getUserById(userId);
    const tokens = generateTokenPair(user);

    // Store refresh token
    const refreshHash = crypto
      .createHash("sha256")
      .update(tokens.refreshToken)
      .digest("hex");
    await db.storeRefreshToken({
      id: uuidv4(),
      user_id: user.id,
      token_hash: refreshHash,
      device_id: "signup_verify",
      ip_address: req.ip,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    metrics.authAttempts.inc({ action: "verify_login", result: "success" });

    res.json({
      message: "Email verified successfully.",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        bio: user.bio || null,
        avatarSeed: user.avatar_seed,
        avatarUrl: user.avatar_url || null,
      },
    });
  } catch (err) {
    console.error("Verification error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── POST /api/auth/login ───────────────────────────────────────────────────
router.post(
  "/login",
  authLimiter,
  abuseGuard("failed_login"),
  async (req, res) => {
    try {
      const { email, password, deviceId } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          error: "Email and password are required",
          code: "VALIDATION_ERROR",
        });
      }

      const user = await db.getUserByEmail(email.toLowerCase());
      if (!user) {
        await recordFailure(req.ip, "failed_login");
        metrics.authAttempts.inc({ action: "login", result: "failure" });
        return res
          .status(401)
          .json({ error: "Invalid email or password", code: "AUTH_FAILED" });
      }

      // Verify password
      const validPassword = await argon2.verify(user.password_hash, password);
      if (!validPassword) {
        await recordFailure(req.ip, "failed_login", user.id);
        metrics.authAttempts.inc({ action: "login", result: "failure" });
        return res
          .status(401)
          .json({ error: "Invalid email or password", code: "AUTH_FAILED" });
      }

      // Check email verification
      if (!user.email_verified) {
        return res.status(403).json({
          error: "Email not verified. Please check your inbox.",
          code: "EMAIL_NOT_VERIFIED",
          userId: user.id,
        });
      }

      // Generate token pair
      const tokens = generateTokenPair(user);

      // Store refresh token (hashed) with device binding
      const refreshHash = crypto
        .createHash("sha256")
        .update(tokens.refreshToken)
        .digest("hex");
      await db.storeRefreshToken({
        id: uuidv4(),
        user_id: user.id,
        token_hash: refreshHash,
        device_id: deviceId || "unknown",
        ip_address: req.ip,
        expires_at: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString(), // 7 days
      });

      resetFailures(req.ip, "failed_login");
      metrics.authAttempts.inc({ action: "login", result: "success" });

      res.json({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          bio: user.bio || null,
          avatarSeed: user.avatar_seed,
          avatarUrl: user.avatar_url || null,
        },
      });
    } catch (err) {
      console.error("Login error:", err);
      metrics.authAttempts.inc({ action: "login", result: "error" });
      res
        .status(500)
        .json({ error: "Internal server error", code: "SERVER_ERROR" });
    }
  },
);

// ─── POST /api/auth/refresh — Single-Use Token Rotation ─────────────────────
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken, deviceId } = req.body;

    if (!refreshToken) {
      return res
        .status(400)
        .json({ error: "Refresh token is required", code: "VALIDATION_ERROR" });
    }

    // Hash the incoming token to look up in DB
    const tokenHash = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");
    const stored = await db.getRefreshToken(tokenHash);

    if (!stored) {
      // Possible token reuse attack — invalidate all tokens for this user
      console.warn(`⚠️  Refresh token reuse detected from IP ${req.ip}`);
      return res.status(401).json({
        error: "Invalid refresh token. Please login again.",
        code: "INVALID_REFRESH",
      });
    }

    // Delete the used token (single-use rotation)
    await db.deleteRefreshToken(tokenHash);

    // Get user
    const user = await db.getUserById(stored.user_id);
    if (!user) {
      return res
        .status(401)
        .json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

    // Generate new pair
    const tokens = generateTokenPair(user);

    // Store new refresh token
    const newHash = crypto
      .createHash("sha256")
      .update(tokens.refreshToken)
      .digest("hex");
    await db.storeRefreshToken({
      id: uuidv4(),
      user_id: stored.user_id,
      token_hash: newHash,
      device_id: deviceId || stored.device_id,
      ip_address: req.ip,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    console.error("Token refresh error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── POST /api/auth/logout ──────────────────────────────────────────────────
router.post("/logout", authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.body;
    await db.deleteAllUserRefreshTokens(req.user.id, deviceId);
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

// ─── POST /api/auth/resend-code ─────────────────────────────────────────────
router.post("/resend-code", authLimiter, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res
        .status(400)
        .json({ error: "userId is required", code: "VALIDATION_ERROR" });
    }

    const user = await db.getUserById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

    if (user.email_verified) {
      return res
        .status(400)
        .json({ error: "Email already verified", code: "ALREADY_VERIFIED" });
    }

    const code = generateCode();
    await db.createVerificationCode({
      id: uuidv4(),
      user_id: userId,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    await sendVerificationEmail(user.email, user.name, code);
    res.json({ message: "Verification code resent" });
  } catch (err) {
    console.error("Resend code error:", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "SERVER_ERROR" });
  }
});

module.exports = router;
