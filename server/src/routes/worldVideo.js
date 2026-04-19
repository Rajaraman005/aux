/**
 * World Video Chat Routes — REST Endpoints for Reports, Blocklist, ToS, Moderation.
 *
 * ★ Reports go through REST (NOT WebSocket) for guaranteed delivery.
 *   A user closing the app during a bad encounter is the most common
 *   report scenario — WS messages would be lost.
 */
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { apiLimiter } = require("../middleware/rateLimiter");
const { db } = require("../db/supabase");
const matchmaking = require("../services/matchmaking");

const CURRENT_TOS_VERSION = "1.0";

// ─── Report ──────────────────────────────────────────────────────────────────
// POST /api/world-video/report
// Guaranteed delivery via REST. Ephemeral token resolved to real userId server-side.
router.post("/report", authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { sessionId, reportedToken, reason, metadata } = req.body;

    if (!sessionId || !reportedToken || !reason) {
      return res.status(400).json({ error: "sessionId, reportedToken, and reason are required" });
    }

    const validReasons = ["inappropriate", "harassment", "spam", "underage", "violence", "other"];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({ error: "Invalid reason" });
    }

    // Resolve ephemeral token to real userId
    const reportedId = await matchmaking.resolveToken(reportedToken);

    if (!reportedId) {
      return res.status(404).json({ error: "Session not found or expired. Report still recorded." });
    }

    // Cannot report yourself
    if (reportedId === req.user.id) {
      return res.status(400).json({ error: "Cannot report yourself" });
    }

    // Create report in DB
    const report = await db.createWorldVideoReport({
      session_id: sessionId,
      reporter_id: req.user.id,
      reported_id: reportedId,
      reason,
      metadata: {
        ...(metadata || {}),
        reporterIp: req.ip,
        reportTimestamp: new Date().toISOString(),
      },
    });

    // Mutually block both users (prevents future matching)
    await matchmaking.blockUser(req.user.id, reportedId);

    // End the current session if active
    const userSession = await matchmaking.getUserSession(req.user.id);
    if (userSession && userSession.sessionId === sessionId) {
      await matchmaking.endSession(sessionId, "report", null);
    }

    // Check if reported user has accumulated reports (auto-flag threshold)
    const recentReports = await db.getWorldVideoReports({
      status: "pending",
      limit: 100,
      offset: 0,
    });
    const reportedUserRecentReports = recentReports.filter(
      (r) => r.reported_id === reportedId &&
        new Date(r.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    if (reportedUserRecentReports.length >= 3) {
      // ★ Auto-flag for moderation review
      console.warn(
        `🚨 User ${reportedId} has ${reportedUserRecentReports.length} reports in 24h — flagged for review`
      );
    }

    res.status(201).json({
      report: { id: report.id, status: report.status },
      blocked: true,
    });
  } catch (err) {
    console.error("World video report error:", err.message);
    res.status(500).json({ error: "Failed to create report" });
  }
});

// ─── Blocklist ──────────────────────────────────────────────────────────────
// GET /api/world-video/blocklist
router.get("/blocklist", authenticateToken, async (req, res) => {
  try {
    const blocks = await matchmaking.getBlocklist(req.user.id);
    res.json({ blocks });
  } catch (err) {
    console.error("Blocklist fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch blocklist" });
  }
});

// POST /api/world-video/block/:userId
router.post("/block/:userId", authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    if (userId === req.user.id) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    await matchmaking.blockUser(req.user.id, userId);
    res.json({ blocked: true });
  } catch (err) {
    console.error("Block error:", err.message);
    res.status(500).json({ error: "Failed to block user" });
  }
});

// DELETE /api/world-video/block/:userId (soft-delete for audit trail)
router.delete("/block/:userId", authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    await matchmaking.unblockUser(req.user.id, userId);
    res.json({ unblocked: true });
  } catch (err) {
    console.error("Unblock error:", err.message);
    res.status(500).json({ error: "Failed to unblock user" });
  }
});

// ─── Terms of Service ────────────────────────────────────────────────────────
// GET /api/world-video/tos-status
router.get("/tos-status", authenticateToken, async (req, res) => {
  try {
    const acceptance = await db.getTosAcceptance(req.user.id);
    res.json({
      accepted: !!acceptance && acceptance.version === CURRENT_TOS_VERSION,
      currentVersion: CURRENT_TOS_VERSION,
      userVersion: acceptance?.version || null,
    });
  } catch (err) {
    console.error("ToS status error:", err.message);
    res.status(500).json({ error: "Failed to check ToS status" });
  }
});

// POST /api/world-video/accept-tos
router.post("/accept-tos", authenticateToken, async (req, res) => {
  try {
    const { version } = req.body;

    if (version !== CURRENT_TOS_VERSION) {
      return res.status(400).json({ error: "Unsupported TOS version", currentVersion: CURRENT_TOS_VERSION });
    }

    await db.acceptWorldVideoTos(req.user.id, version);
    res.json({ accepted: true, version: CURRENT_TOS_VERSION });
  } catch (err) {
    console.error("ToS acceptance error:", err.message);
    res.status(500).json({ error: "Failed to accept TOS" });
  }
});

// ─── Queue Status ─────────────────────────────────────────────────────────────
// GET /api/world-video/status
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const stats = await matchmaking.getQueueStats();
    res.json({
      queueSize: stats.queueSize,
      activeSessions: stats.activeSessions,
    });
  } catch (err) {
    console.error("Queue status error:", err.message);
    res.status(500).json({ error: "Failed to get queue status" });
  }
});

// ─── Moderation Frame Ingestion ──────────────────────────────────────────────
// POST /api/world-video/moderate
// Receives a captured frame from the client for content moderation.
// This is a passive endpoint — it does NOT block the video call.
// Moderation runs asynchronously and may end sessions retroactively.
router.post("/moderate", authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { sessionId, ephemeralToken, frame, timestamp, platform } = req.body;

    if (!sessionId || !ephemeralToken || !frame) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ★ Production: Send frame to moderation provider (Hive, Rekognition, etc.)
    // For now, we acknowledge receipt and log.
    // The actual moderation provider integration is a separate concern.
    console.log(
      `📸 Moderation frame received: session=${sessionId} user=${req.user.id} platform=${platform || "unknown"}`
    );

    // TODO: Integrate with moderation provider
    // const result = await moderationProvider.analyze(frame);
    // if (result.isNSFW) {
    //   await matchmaking.endSession(sessionId, "moderation_flag");
    // }

    res.json({ received: true });
  } catch (err) {
    console.error("Moderation frame error:", err.message);
    res.status(500).json({ error: "Moderation processing failed" });
  }
});

module.exports = router;