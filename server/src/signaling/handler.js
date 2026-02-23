/**
 * WebSocket Signaling Handler.
 * Manages WebRTC signaling: call initiation, offer/answer exchange,
 * ICE candidate trickling, and call lifecycle.
 *
 * Message Protocol:
 *   { type: 'call-request', targetUserId, ... }
 *   { type: 'call-accept', callId, ... }
 *   { type: 'call-reject', callId, reason, ... }
 *   { type: 'offer', callId, sdp, ... }
 *   { type: 'answer', callId, sdp, ... }
 *   { type: 'ice-candidate', callId, candidate, ... }
 *   { type: 'hang-up', callId, ... }
 *   { type: 'ice-restart', callId, ... }
 *   { type: 'heartbeat' }
 *   { type: 'call-metrics', callId, metrics, ... }
 */
const { v4: uuidv4 } = require("uuid");
const { verifyToken } = require("../middleware/auth");
const { isBlocked, recordFailure } = require("../middleware/abuse");
const presence = require("./presence");
const { db } = require("../db/supabase");
const metrics = require("../services/metrics");

// Active calls: callId -> { callerId, calleeId, startedAt, state }
const activeCalls = new Map();

// Message rate limiting per connection
const MESSAGE_RATE_LIMIT = 50; // messages per second
const rateLimitCounters = new Map(); // ws -> { count, resetAt }

function checkRateLimit(ws) {
  const now = Date.now();
  let counter = rateLimitCounters.get(ws);

  if (!counter || now > counter.resetAt) {
    counter = { count: 0, resetAt: now + 1000 };
    rateLimitCounters.set(ws, counter);
  }

  counter.count++;
  return counter.count <= MESSAGE_RATE_LIMIT;
}

/**
 * Initialize WebSocket signaling on the HTTP server.
 */
function initializeSignaling(wss) {
  wss.on("connection", async (ws, req) => {
    // ─── Authentication ─────────────────────────────────────────────────
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "Authentication required");
      return;
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      ws.close(4002, "Invalid token");
      return;
    }

    const userId = decoded.sub;
    const userName = decoded.name;

    // Check abuse block
    const clientIp = req.socket.remoteAddress;
    if (isBlocked(clientIp, "call_spam")) {
      ws.close(4003, "Temporarily blocked");
      return;
    }

    // ─── Register Presence ──────────────────────────────────────────────
    await presence.userConnected(userId, ws);
    metrics.activeConnections.inc();

    console.log(`🟢 ${userName} (${userId}) connected from ${clientIp}`);

    // Send online users list
    const onlineUsers = await presence.getOnlineUserIds();
    ws.send(
      JSON.stringify({
        type: "presence-list",
        users: onlineUsers.filter((id) => id !== userId),
      }),
    );

    // ─── Heartbeat ──────────────────────────────────────────────────────
    const heartbeatInterval = setInterval(async () => {
      if (ws.readyState === 1) {
        ws.ping();
        await presence.heartbeat(userId);
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 30000);

    // ─── Message Handler ────────────────────────────────────────────────
    ws.on("message", async (raw) => {
      // Rate limit check
      if (!checkRateLimit(ws)) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "RATE_LIMITED",
            message: "Too many messages",
          }),
        );
        return;
      }

      const startTime = Date.now();

      try {
        const message = JSON.parse(raw.toString());

        switch (message.type) {
          case "call-request":
            await handleCallRequest(userId, userName, message, ws);
            break;
          case "call-accept":
            await handleCallAccept(userId, message);
            break;
          case "call-reject":
            await handleCallReject(userId, message);
            break;
          case "offer":
            await handleOffer(userId, message);
            break;
          case "answer":
            await handleAnswer(userId, message);
            break;
          case "ice-candidate":
            await handleIceCandidate(userId, message);
            break;
          case "hang-up":
            await handleHangUp(userId, message);
            break;
          case "ice-restart":
            await handleIceRestart(userId, message);
            break;
          case "call-metrics":
            await handleCallMetrics(message);
            break;
          case "chat-message":
            await handleChatMessage(userId, userName, message, ws);
            break;
          case "typing":
            await handleTyping(userId, message);
            break;
          case "message-read":
            await handleMessageRead(userId, message);
            break;
          case "world-message":
            await handleWorldMessage(userId, userName, message, ws, wss);
            break;
          case "heartbeat":
            ws.send(
              JSON.stringify({ type: "heartbeat-ack", timestamp: Date.now() }),
            );
            break;
          default:
            ws.send(
              JSON.stringify({
                type: "error",
                code: "UNKNOWN_TYPE",
                message: `Unknown message type: ${message.type}`,
              }),
            );
        }

        // Track signaling latency
        metrics.signalingLatency.observe(Date.now() - startTime);
      } catch (err) {
        console.error("Message handling error:", err);
        ws.send(
          JSON.stringify({
            type: "error",
            code: "PROCESSING_ERROR",
            message: "Failed to process message",
          }),
        );
      }
    });

    // ─── Disconnect ─────────────────────────────────────────────────────
    ws.on("close", async () => {
      clearInterval(heartbeatInterval);
      rateLimitCounters.delete(ws);

      // Clean up any active calls for this user
      for (const [callId, call] of activeCalls) {
        if (call.callerId === userId || call.calleeId === userId) {
          const otherUserId =
            call.callerId === userId ? call.calleeId : call.callerId;
          await presence.sendToUser(otherUserId, {
            type: "call-ended",
            callId,
            reason: "peer_disconnected",
          });
          await finalizeCall(callId, "peer_disconnected");
        }
      }

      await presence.userDisconnected(userId);
      metrics.activeConnections.dec();
      console.log(`🔴 ${userName} (${userId}) disconnected`);
    });

    ws.on("error", (err) => {
      console.error(`WebSocket error for ${userId}:`, err.message);
    });
  });
}

// ─── Message Handlers ────────────────────────────────────────────────────────

async function handleCallRequest(callerId, callerName, message, callerWs) {
  const { targetUserId } = message;

  if (!targetUserId) {
    callerWs.send(
      JSON.stringify({
        type: "error",
        code: "MISSING_TARGET",
        message: "targetUserId is required",
      }),
    );
    return;
  }

  // Check if target is online
  const targetOnline = await presence.isOnline(targetUserId);
  if (!targetOnline) {
    callerWs.send(
      JSON.stringify({
        type: "call-failed",
        reason: "user_offline",
        targetUserId,
      }),
    );
    metrics.callFailures.inc({ reason: "user_offline" });
    return;
  }

  // Check if either party is already in a call
  for (const [, call] of activeCalls) {
    if (
      call.state !== "ended" &&
      (call.callerId === callerId || call.calleeId === callerId)
    ) {
      callerWs.send(
        JSON.stringify({ type: "call-failed", reason: "already_in_call" }),
      );
      return;
    }
    if (
      call.state !== "ended" &&
      (call.callerId === targetUserId || call.calleeId === targetUserId)
    ) {
      callerWs.send(
        JSON.stringify({ type: "call-failed", reason: "target_busy" }),
      );
      return;
    }
  }

  // Create call
  const callId = uuidv4();
  activeCalls.set(callId, {
    callerId,
    calleeId: targetUserId,
    callerName,
    startedAt: Date.now(),
    state: "ringing", // ringing -> connecting -> active -> ended
  });

  metrics.activeCalls.inc();

  // Notify callee
  await presence.sendToUser(targetUserId, {
    type: "incoming-call",
    callId,
    callerId,
    callerName,
    timestamp: Date.now(),
  });

  // Confirm to caller
  callerWs.send(
    JSON.stringify({
      type: "call-ringing",
      callId,
      targetUserId,
    }),
  );

  // Auto-timeout after 30s if no answer
  setTimeout(async () => {
    const call = activeCalls.get(callId);
    if (call && call.state === "ringing") {
      await presence.sendToUser(callerId, {
        type: "call-failed",
        callId,
        reason: "no_answer",
      });
      await presence.sendToUser(targetUserId, {
        type: "call-ended",
        callId,
        reason: "timeout",
      });
      await finalizeCall(callId, "no_answer");
    }
  }, 30000);

  // Create call log
  await db.createCallLog({
    id: callId,
    caller_id: callerId,
    callee_id: targetUserId,
    started_at: new Date().toISOString(),
  });
}

async function handleCallAccept(userId, message) {
  const { callId } = message;
  const call = activeCalls.get(callId);

  if (!call || call.state !== "ringing" || call.calleeId !== userId) {
    return;
  }

  call.state = "connecting";

  // Notify caller that callee accepted
  await presence.sendToUser(call.callerId, {
    type: "call-accepted",
    callId,
    calleeId: userId,
  });
}

async function handleCallReject(userId, message) {
  const { callId, reason } = message;
  const call = activeCalls.get(callId);

  if (!call || call.calleeId !== userId) return;

  await presence.sendToUser(call.callerId, {
    type: "call-rejected",
    callId,
    reason: reason || "rejected",
  });

  await finalizeCall(callId, reason || "rejected");
}

async function handleOffer(userId, message) {
  const { callId, sdp } = message;
  const call = activeCalls.get(callId);

  if (!call) return;

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "offer",
    callId,
    sdp,
    fromUserId: userId,
  });
}

async function handleAnswer(userId, message) {
  const { callId, sdp } = message;
  const call = activeCalls.get(callId);

  if (!call) return;

  call.state = "active";

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "answer",
    callId,
    sdp,
    fromUserId: userId,
  });
}

async function handleIceCandidate(userId, message) {
  const { callId, candidate } = message;
  const call = activeCalls.get(callId);

  if (!call) return;

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "ice-candidate",
    callId,
    candidate,
    fromUserId: userId,
  });
}

async function handleIceRestart(userId, message) {
  const { callId, sdp } = message;
  const call = activeCalls.get(callId);

  if (!call) return;

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "ice-restart",
    callId,
    sdp,
    fromUserId: userId,
  });
}

async function handleHangUp(userId, message) {
  const { callId } = message;
  const call = activeCalls.get(callId);

  if (!call) return;

  const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(otherUserId, {
    type: "call-ended",
    callId,
    reason: "hang_up",
  });

  await finalizeCall(callId, "normal");
}

async function handleCallMetrics(message) {
  const { callId, stats } = message;

  if (stats) {
    if (stats.packetLoss !== undefined)
      metrics.packetLoss.observe(stats.packetLoss);
    if (stats.jitter !== undefined) metrics.jitter.observe(stats.jitter);
    if (stats.rtt !== undefined) metrics.rtt.observe(stats.rtt);
  }

  // Update call log with quality metrics
  if (callId && stats) {
    try {
      await db.updateCallLog(callId, {
        avg_packet_loss: stats.packetLoss,
        avg_jitter: stats.jitter,
        avg_rtt: stats.rtt,
        avg_audio_bitrate: stats.audioBitrate,
        avg_video_bitrate: stats.videoBitrate,
        mode_switches: stats.modeSwitches || 0,
      });
    } catch (err) {
      // Non-critical — don't fail on metrics storage
      console.error("Failed to update call metrics:", err.message);
    }
  }
}

async function finalizeCall(callId, reason) {
  const call = activeCalls.get(callId);
  if (!call) return;

  call.state = "ended";
  const duration = Date.now() - call.startedAt;

  metrics.activeCalls.dec();
  metrics.callDuration.observe(duration / 1000);

  if (reason !== "normal" && reason !== "hang_up") {
    metrics.callFailures.inc({ reason });
  }

  // Update call log
  try {
    await db.updateCallLog(callId, {
      ended_at: new Date().toISOString(),
      duration_ms: duration,
      end_reason: reason,
    });
  } catch (err) {
    console.error("Failed to update call log:", err.message);
  }

  // Clean up after a delay (allow late ICE candidates)
  setTimeout(() => activeCalls.delete(callId), 5000);
}

// ─── Chat Message Handlers ──────────────────────────────────────────────────

async function handleChatMessage(userId, userName, message, ws) {
  const { conversationId, content, tempId } = message;
  if (!conversationId || !content || content.trim().length === 0) return;
  if (content.length > 5000) return;

  try {
    // Save to database
    const savedMessage = await db.createMessage({
      conversation_id: conversationId,
      sender_id: userId,
      content: content.trim(),
    });

    // Confirm to sender (maps tempId to permanent ID)
    ws.send(
      JSON.stringify({
        type: "message-confirmed",
        tempId,
        message: savedMessage,
      }),
    );

    // Deliver to other participants
    const participants = await db.getConversationParticipants(conversationId);
    for (const participantId of participants) {
      if (participantId !== userId) {
        await presence.sendToUser(participantId, {
          type: "message-received",
          conversationId,
          message: { ...savedMessage, senderName: userName },
        });
      }
    }
  } catch (err) {
    console.error("Chat message error:", err.message);
    ws.send(
      JSON.stringify({
        type: "error",
        code: "CHAT_ERROR",
        message: "Failed to send message",
      }),
    );
  }
}

async function handleTyping(userId, message) {
  const { conversationId } = message;
  if (!conversationId) return;

  try {
    const participants = await db.getConversationParticipants(conversationId);
    for (const participantId of participants) {
      if (participantId !== userId) {
        await presence.sendToUser(participantId, {
          type: "typing",
          conversationId,
          userId,
        });
      }
    }
  } catch (err) {
    // Non-critical — don't fail on typing indicator
  }
}

async function handleMessageRead(userId, message) {
  const { conversationId } = message;
  if (!conversationId) return;

  try {
    await db.markMessagesRead(conversationId, userId);
    const participants = await db.getConversationParticipants(conversationId);
    for (const participantId of participants) {
      if (participantId !== userId) {
        await presence.sendToUser(participantId, {
          type: "messages-read",
          conversationId,
          readBy: userId,
        });
      }
    }
  } catch (err) {
    console.error("Message read error:", err.message);
  }
}

async function handleWorldMessage(userId, userName, message, ws, wss) {
  const { content, tempId } = message;
  if (!content || content.trim().length === 0) return;
  if (content.length > 1000) return;

  try {
    const user = await db.getUserById(userId);
    const savedMessage = await db.createWorldMessage({
      sender_id: userId,
      sender_name: userName,
      sender_avatar: user?.avatar_seed || userId,
      content: content.trim(),
    });

    // Confirm to sender (maps tempId → real ID)
    ws.send(
      JSON.stringify({
        type: "world-message-confirmed",
        tempId,
        message: savedMessage,
      }),
    );

    // Broadcast to ALL other connected clients
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === 1) {
        client.send(
          JSON.stringify({
            type: "world-message-received",
            message: savedMessage,
          }),
        );
      }
    });
  } catch (err) {
    console.error("World message error:", err.message);
    ws.send(
      JSON.stringify({
        type: "error",
        code: "WORLD_CHAT_ERROR",
        message: "Failed to send world message",
      }),
    );
  }
}

module.exports = { initializeSignaling, activeCalls };
