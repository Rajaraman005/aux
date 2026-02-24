/**
 * Call Routes — REST endpoints for call operations.
 *
 * POST /api/calls/reject — Reject a call from background (when WS unavailable).
 */
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { activeCalls } = require("../signaling/handler");
const presence = require("../signaling/presence");

router.use(authenticateToken);

// ─── POST /reject — Background call rejection ──────────────────────────────
router.post("/reject", async (req, res) => {
  const { callId, reason } = req.body;
  const userId = req.user.sub;

  if (!callId) {
    return res.status(400).json({ error: "callId is required" });
  }

  const call = activeCalls.get(callId);
  if (!call || call.calleeId !== userId) {
    return res.status(404).json({ error: "Call not found" });
  }

  if (call.state === "ended") {
    return res.json({ success: true, message: "Call already ended" });
  }

  // Notify the caller
  await presence.sendToUser(call.callerId, {
    type: "call-rejected",
    callId,
    reason: reason || "rejected",
  });

  // Finalize
  call.state = "ended";
  setTimeout(() => activeCalls.delete(callId), 5000);

  res.json({ success: true });
});

module.exports = router;
