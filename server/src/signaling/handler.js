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
const matchmaking = require("../services/matchmaking");
const {
  sendMessagePush,
  sendCallPush,
  sendMissedCallPush,
} = require("../services/pushService");
const logger = require("../services/logger").default;
const callSessionStore = require("../services/callSessionStore");
const guaranteedDelivery = require("../services/guaranteedDelivery");
const heartbeatWatchdog = require("../services/heartbeatWatchdog");

// Active calls: callId -> { callerId, calleeId, startedAt, state }
// ★ REPLACED with Redis-backed callSessionStore for FAANG-grade scalability
const activeCalls = new Map(); // Kept for temporary compatibility during migration

// ★ Disconnect grace timers: userId -> timeoutId
// When a user disconnects, we delay call cleanup to allow push-woken reconnects.
const disconnectTimers = new Map();

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
    metrics.activeConnections(1);

    // Flush any pending critical events (world-session-end, call-ended, etc.)
    await guaranteedDelivery.flushPendingEvents(userId);

    // ★ Cancel any pending disconnect cleanup timer (user reconnected in time)
    const pendingTimer = disconnectTimers.get(userId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      disconnectTimers.delete(userId);
      console.log(
        `✅ ${userName} (${userId}) reconnected — cancelled call cleanup`,
      );
    }

    console.log(`🟢 ${userName} (${userId}) connected from ${clientIp}`);

    // Send online users list
    const onlineUsers = await presence.getOnlineUserIds();
    ws.send(
      JSON.stringify({
        type: "presence-list",
        users: onlineUsers.filter((id) => id !== userId),
      }),
    );

    // ★ Deliver pending incoming-call if user was woken by push notification
    for (const [callId, call] of activeCalls) {
      if (
        call.calleeId === userId &&
        call.state === "ringing" &&
        call.pendingCallMessage
      ) {
        console.log(
          `📞 Delivering pending call ${callId} to push-woken user ${userId}`,
        );
        ws.send(JSON.stringify(call.pendingCallMessage));
        // Clear pending flag — message delivered
        delete call.pendingCallMessage;
        call.pushWakeUp = false;
        break; // Only one pending call at a time
      }
    }

    // ─── Heartbeat ──────────────────────────────────────────────────────
    // ★ Heartbeat every 25s — 3.6× safety margin against 90s Redis TTL
    const heartbeatInterval = setInterval(async () => {
      if (ws.readyState === 1) {
        ws.ping();
        await presence.heartbeat(userId);
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 25000);

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
          case "call-mode-switch":
            await handleCallModeSwitch(userId, message);
            break;
          case "call-mode-request":
            await handleCallModeRequest(userId, message);
            break;
          case "call-mode-response":
            await handleCallModeResponse(userId, message);
            break;
          case "call-rejoin":
            await handleCallRejoin(userId, message, ws);
            break;
          case "call-metrics":
            await handleCallMetrics(message);
            break;
          case "call-status":
            handleCallStatus(message, ws);
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
          case "world-typing":
            handleWorldTyping(userId, userName, ws, wss);
            break;
          // ─── World Video Chat Signaling ──────────────────────────────────
          case "world-join":
            await handleWorldJoin(userId, ws);
            break;
          case "world-leave":
            await handleWorldLeave(userId, message);
            break;
          case "world-next":
            await handleWorldNext(userId, message);
            break;
          case "world-video-offer":
            await handleWorldVideoOffer(userId, message);
            break;
          case "world-video-answer":
            await handleWorldVideoAnswer(userId, message);
            break;
          case "world-video-ice-candidate":
            await handleWorldVideoIceCandidate(userId, message);
            break;
          case "world-video-ice-restart":
            await handleWorldVideoIceRestart(userId, message);
            break;
          case "world-video-camera-state":
            await handleWorldVideoCameraState(userId, message);
            break;
          case "heartbeat":
            ws.send(
              JSON.stringify({ type: "heartbeat-ack", timestamp: Date.now() }),
            );
            break;
          case "ack":
            await handleAck(userId, message);
            break;
          case "call-heartbeat":
            await handleCallHeartbeat(userId, message);
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
        metrics.signalingLatency(Date.now() - startTime);
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

      await presence.userDisconnected(userId);
      metrics.activeConnections(0);
      logger.info('User disconnected', { userId, userName });

      // ★ Check if this user has any active calls using Redis
      const allCalls = await callSessionStore.getAllActiveCalls();
      let hasActiveCalls = false;
      for (const call of allCalls) {
        if (
          call.state !== callSessionStore.CALL_STATES.ENDED &&
          (call.callerId === userId || call.calleeId === userId)
        ) {
          hasActiveCalls = true;
          break;
        }
      }

      if (hasActiveCalls) {
        // ★ GRACE PERIOD: Wait 10 seconds before killing calls.
        // This allows push-woken users to reconnect via a new WebSocket
        // before we destroy their pending/active calls.
        const GRACE_PERIOD_MS = 10000;
        logger.info('User has active calls, starting grace period', { userId, gracePeriod: GRACE_PERIOD_MS });

        const timer = setTimeout(async () => {
          disconnectTimers.delete(userId);

          // Check if user reconnected during grace period
          const isBackOnline = await presence.isOnline(userId);
          if (isBackOnline) {
            logger.info('User reconnected during grace period, skipping cleanup', { userId });
            return;
          }

          // User did NOT reconnect — clean up their calls using Redis
          logger.warn('User did not reconnect, cleaning up calls', { userId });
          
          const currentCalls = await callSessionStore.getAllActiveCalls();
          for (const call of currentCalls) {
            if (
              call.state !== callSessionStore.CALL_STATES.ENDED &&
              (call.callerId === userId || call.calleeId === userId)
            ) {
              const otherUserId =
                call.callerId === userId ? call.calleeId : call.callerId;
              
              // Send call-ended with guaranteed delivery
              await guaranteedDelivery.sendCriticalEvent(otherUserId, 'call-ended', {
                callId: call.callId,
                reason: 'peer_disconnected',
              });
              
              await callSessionStore.transitionCallState(call.callId, callSessionStore.CALL_STATES.ENDED);
              await finalizeCall(call.callId, "peer_disconnected");
              
              // Update in-memory Map for compatibility
              const memoryCall = activeCalls.get(call.callId);
              if (memoryCall) {
                memoryCall.state = "ended";
              }
            }
          }
        }, GRACE_PERIOD_MS);

        disconnectTimers.set(userId, timer);
      }

      // ★ Clean up world video match state on disconnect
      matchmaking.handleDisconnect(userId).catch((err) => {
        logger.error('World video disconnect cleanup error', { userId, error: err.message });
      });
    });

    ws.on("error", (err) => {
      console.error(`WebSocket error for ${userId}:`, err.message);
    });
  });
}

// ─── Message Handlers ────────────────────────────────────────────────────────

async function handleCallRequest(callerId, callerName, message, callerWs) {
  const { targetUserId, callType: rawCallType } = message;
  const callType = rawCallType === "voice" ? "voice" : "video";

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
  const callId = uuidv4();
  const callerAvatar = message.callerAvatar || null;

  // ─── Check for existing call ───────────────────────────────────────────────
  const allCalls = await callSessionStore.getAllActiveCalls();
  for (const call of allCalls) {
    if (
      call.callerId === callerId ||
      call.calleeId === callerId ||
      call.callerId === targetUserId ||
      call.calleeId === targetUserId
    ) {
      callerWs.send(
        JSON.stringify({
          type: "call-failed",
          reason: "user_in_call",
        }),
      );
      return;
    }
  }

  // ─── Create Call Session (Redis-backed) ────────────────────────────────────
  const callData = {
    callId,
    callerId,
    calleeId: targetUserId,
    callerName,
    callerAvatar,
    callType,
  };

  const session = await callSessionStore.createCall(callData);
  
  // Transition to RINGING state
  await callSessionStore.transitionCallState(callId, callSessionStore.CALL_STATES.RINGING);
  
  // Also keep in-memory Map for temporary compatibility
  activeCalls.set(callId, {
    ...callData,
    state: "ringing",
    startedAt: Date.now(),
    pushWakeUp: false,
  });
  
  metrics.activeCalls(1);

  // Create call log
  await db.createCallLog({
    id: callId,
    caller_id: callerId,
    callee_id: targetUserId,
    started_at: new Date().toISOString(),
  });

  // Check if target is online
  const targetOnline = await presence.isOnline(targetUserId);

  // ★ ALWAYS send call push with the REAL callId — needed for:
  //   1. Offline users: wakes device, shows full-screen call UI
  //   2. Background users: wakes app, shows lock-screen call notification
  //   3. Foreground users: backup in case WebSocket message is delayed
  sendCallPush(targetUserId, callerId, callerName, callId, callType).catch(
    (err) => console.error("Call push error (non-blocking):", err.message),
  );

  if (targetOnline) {
    // ── Online: deliver via WebSocket immediately ──────────────────────
    await presence.sendToUser(targetUserId, {
      type: "incoming-call",
      callId,
      callerId,
      callerName,
      callerAvatar,
      callType,
      timestamp: Date.now(),
    });
  } else {
    // ── Offline: mark as push wake-up, store pending call data ─────────
    callData.pushWakeUp = true;
    // ★ Store the incoming-call message so we can deliver it when the
    //   callee reconnects via push wake-up (handleCallRejoin)
    callData.pendingCallMessage = {
      type: "incoming-call",
      callId,
      callerId,
      callerName,
      callerAvatar,
      callType,
      timestamp: Date.now(),
    };
    console.log(
      `📞 Call ${callId}: ${callerName} → offline user ${targetUserId} (push sent, waiting for wake-up)`,
    );
  }

  // Confirm to caller — ALWAYS show "ringing" (even for offline users)
  callerWs.send(
    JSON.stringify({
      type: "call-ringing",
      callId,
      targetUserId,
      callType,
    }),
  );

  // ★ Auto-timeout after 45s (extended from 30s to allow push wake-up)
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
      // Send missed call push notification
      await sendMissedCallPush(targetUserId, callerName);
      await finalizeCall(callId, "no_answer");
    }
  }, 45000);
}

async function handleCallAccept(userId, message) {
  const { callId } = message;
  
  const call = await callSessionStore.getCall(callId);

  if (!call || call.state !== callSessionStore.CALL_STATES.RINGING || call.calleeId !== userId) {
    return;
  }

  // Transition to CONNECTING state
  await callSessionStore.transitionCallState(callId, callSessionStore.CALL_STATES.CONNECTING);

  // Notify caller that callee accepted
  await presence.sendToUser(call.callerId, {
    type: "call-accepted",
    callId,
    calleeId: userId,
  });
  
  // Update in-memory Map for compatibility
  const memoryCall = activeCalls.get(callId);
  if (memoryCall) {
    memoryCall.state = "connecting";
  }
}

async function handleCallReject(userId, message) {
  const { callId, reason } = message;
  const call = await callSessionStore.getCall(callId);

  if (!call || call.calleeId !== userId) return;

  // Transition to FAILED state
  await callSessionStore.transitionCallState(callId, callSessionStore.CALL_STATES.FAILED);

  await presence.sendToUser(call.callerId, {
    type: "call-rejected",
    callId,
    reason: reason || "rejected",
  });

  await finalizeCall(callId, reason || "rejected");
  
  // Update in-memory Map for compatibility
  const memoryCall = activeCalls.get(callId);
  if (memoryCall) {
    memoryCall.state = "ended";
  }
}

async function handleOffer(userId, message) {
  const { callId, sdp } = message;
  const call = await callSessionStore.getCall(callId);

  // ★ Validate: only forward offer in connecting/active states
  if (!call || call.state === callSessionStore.CALL_STATES.ENDED || call.state === callSessionStore.CALL_STATES.RINGING) return;

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
  const call = await callSessionStore.getCall(callId);

  // ★ Validate: only accept answer when connecting
  if (!call || call.state === callSessionStore.CALL_STATES.ENDED) return;

  // Transition to CONNECTED state
  await callSessionStore.transitionCallState(callId, callSessionStore.CALL_STATES.CONNECTED);

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "answer",
    callId,
    sdp,
    fromUserId: userId,
  });
  
  // Update in-memory Map for compatibility
  const memoryCall = activeCalls.get(callId);
  if (memoryCall) {
    memoryCall.state = "active";
  }
}

async function handleIceCandidate(userId, message) {
  const { callId, candidate } = message;
  const call = await callSessionStore.getCall(callId);

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
  const call = await callSessionStore.getCall(callId);

  if (!call) return;

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "ice-restart",
    callId,
    sdp,
    fromUserId: userId,
  });
}

async function handleCallModeSwitch(userId, message) {
  const { callId, mode } = message; // mode: "voice" or "video"
  const call = activeCalls.get(callId);
  if (!call || call.state === "ended") return;

  // Update stored call type
  if (mode === "voice" || mode === "video") {
    call.callType = mode;
  }

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "call-mode-switch",
    callId,
    mode,
    fromUserId: userId,
  });
}

// --- Call Mode Request (Consent Flow) ---
async function handleCallModeRequest(userId, message) {
  const { callId, mode } = message;
  const call = activeCalls.get(callId);
  if (!call || call.state === "ended") return;

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "call-mode-request",
    callId,
    mode,
    fromUserId: userId,
  });
}

// --- Call Mode Response (Consent Flow) ---
async function handleCallModeResponse(userId, message) {
  const { callId, accepted } = message;
  const call = activeCalls.get(callId);
  if (!call || call.state === "ended") return;

  const targetId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(targetId, {
    type: "call-mode-response",
    callId,
    accepted,
    fromUserId: userId,
  });
}

async function handleAck(userId, message) {
  const { _ackSeq, _forType } = message;
  
  if (!_ackSeq || !_forType) {
    return;
  }
  
  await guaranteedDelivery.handleAck(userId, _ackSeq, _forType);
  logger.info('ACK received', { userId, seq: _ackSeq, type: _forType });
}

async function handleCallHeartbeat(userId, message) {
  const { callId } = message;
  
  const call = await callSessionStore.getCall(callId);
  
  if (!call) {
    // Call doesn't exist - tell client to end
    await guaranteedDelivery.sendCriticalEvent(userId, 'call-ended', {
      callId,
      reason: 'call_not_found',
    });
    logger.warn('Heartbeat for non-existent call', { userId, callId });
    return;
  }
  
  // Verify user is part of this call
  if (call.callerId !== userId && call.calleeId !== userId) {
    await guaranteedDelivery.sendCriticalEvent(userId, 'call-ended', {
      callId,
      reason: 'not_participant',
    });
    logger.warn('Heartbeat from non-participant', { userId, callId });
    return;
  }
  
  // Update heartbeat timestamp
  await callSessionStore.updateHeartbeat(callId);
  metrics.heartbeatReceived();
}

async function handleHangUp(userId, message) {
  const { callId } = message;
  
  // Check idempotency first
  const existingResult = await guaranteedDelivery.checkIdempotency(callId, userId, 'hangup');
  if (existingResult) {
    logger.info('Idempotent hang-up already processed', { callId, userId });
    return existingResult;
  }

  const call = await callSessionStore.getCall(callId);

  // ★ Guard against already-ended or missing calls
  if (!call || call.state === callSessionStore.CALL_STATES.ENDED) {
    const result = { success: true, alreadyEnded: true };
    await guaranteedDelivery.storeIdempotencyResult(callId, userId, 'hangup', result);
    return result;
  }

  // Verify user is part of this call
  if (call.callerId !== userId && call.calleeId !== userId) {
    const result = { success: false, error: 'not_participant' };
    await guaranteedDelivery.storeIdempotencyResult(callId, userId, 'hangup', result);
    return result;
  }

  // Check if already ending
  if (call.state === callSessionStore.CALL_STATES.ENDING) {
    const result = { success: true, alreadyEnding: true };
    await guaranteedDelivery.storeIdempotencyResult(callId, userId, 'hangup', result);
    return result;
  }

  // Transition to ENDING state
  await callSessionStore.transitionCallState(callId, callSessionStore.CALL_STATES.ENDING);

  const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
  
  // ★ FAANG-grade: Send call-ended with guaranteed delivery
  await guaranteedDelivery.sendCriticalEvent(otherUserId, 'call-ended', {
    callId,
    reason: 'hang_up',
    endedBy: userId,
  });

  // Start forced teardown timer (if ACK not received in 5s)
  setTimeout(async () => {
    const currentCall = await callSessionStore.getCall(callId);
    if (currentCall && currentCall.state === callSessionStore.CALL_STATES.ENDING) {
      logger.warn('Forced teardown - ACK not received', { callId });
      metrics.ghostConnections();
      await forceEndCall(callId, 'forced_teardown');
    }
  }, 5000);

  // Store idempotency result
  const result = { success: true };
  await guaranteedDelivery.storeIdempotencyResult(callId, userId, 'hangup', result);
  
  // Also update in-memory Map for compatibility
  const memoryCall = activeCalls.get(callId);
  if (memoryCall) {
    memoryCall.state = "ended";
  }
  
  await finalizeCall(callId, "normal");
  return result;
}

async function forceEndCall(callId, reason) {
  logger.warn('Force ending call', { callId, reason });
  
  const call = await callSessionStore.getCall(callId);
  if (!call || call.state === callSessionStore.CALL_STATES.ENDED) {
    return;
  }
  
  // Send to both users with guaranteed delivery
  await guaranteedDelivery.sendCriticalEvent(call.callerId, 'call-ended', { callId, reason });
  await guaranteedDelivery.sendCriticalEvent(call.calleeId, 'call-ended', { callId, reason });
  
  // Mark as ended in Redis
  await callSessionStore.transitionCallState(callId, callSessionStore.CALL_STATES.ENDED);
  
  // Update in-memory Map for compatibility
  const memoryCall = activeCalls.get(callId);
  if (memoryCall) {
    memoryCall.state = "ended";
  }
  
  // Log to database
  await db.updateCallLog(callId, {
    ended_at: new Date().toISOString(),
    end_reason: reason,
  });
  
  metrics.ghostConnections();
}

// ★ Call Status Query (for client-side network reconciliation)
function handleCallStatus(message, ws) {
  const { callId } = message;
  const call = activeCalls.get(callId);
  ws.send(
    JSON.stringify({
      type: "call-status-response",
      callId,
      active: !!call && call.state !== "ended",
      state: call?.state || "not_found",
    }),
  );
}

// ★ Call Rejoin — Client reconnected WebSocket mid-call
async function handleCallRejoin(userId, message, ws) {
  const { callId, token } = message;
  
  // ★ FAANG-grade: Validate JWT token for rejoin
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, config.jwt.accessSecret);
      if (decoded.userId !== userId || decoded.callId !== callId) {
        logger.warn('Invalid rejoin token', { userId, callId });
        ws.send(JSON.stringify({
          type: 'call-rejoin-response',
          callId,
          success: false,
          reason: 'invalid_token'
        }));
        return;
      }
    } catch (err) {
      logger.warn('Rejoin token verification failed', { userId, callId, error: err.message });
    }
  }

  const call = await callSessionStore.getCall(callId);

  if (!call || call.state === callSessionStore.CALL_STATES.ENDED) {
    ws.send(
      JSON.stringify({
        type: "call-rejoin-response",
        callId,
        success: false,
        reason: "call_not_found",
      }),
    );
    // Force send call-ended to ensure client knows to cleanup
    await guaranteedDelivery.sendCriticalEvent(userId, 'call-ended', { callId, reason: 'call_expired' });
    return;
  }

  // Verify user is part of call
  if (call.callerId !== userId && call.calleeId !== userId) {
    ws.send(
      JSON.stringify({
        type: "call-rejoin-response",
        callId,
        success: false,
        reason: "not_participant",
      }),
    );
    return;
  }

  // Re-register presence
  await presence.userConnected(userId, ws);

  // Flush pending events
  await guaranteedDelivery.flushPendingEvents(userId);

  // Send current state
  ws.send(
    JSON.stringify({
      type: "call-rejoin-response",
      callId,
      success: true,
      state: call.state,
      callType: call.callType,
    }),
  );

  logger.info(`User rejoined call`, { userId, callId, state: call.state });
}

async function handleCallMetrics(message) {
  const { callId, stats } = message;

  if (stats) {
    if (stats.packetLoss !== undefined)
      metrics.packetLoss(stats.packetLoss);
    if (stats.jitter !== undefined) metrics.jitter(stats.jitter);
    if (stats.rtt !== undefined) metrics.rtt(stats.rtt);
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
  // ★ Guard against double-finalization
  if (!call || call.state === "ended") return;

  call.state = "ended";
  const duration = Date.now() - call.startedAt;

  metrics.activeCalls(0);
  metrics.callDuration(duration / 1000);

  if (reason !== "normal" && reason !== "hang_up") {
    metrics.callFailures(reason);
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
  const {
    conversationId,
    content,
    tempId,
    media_url,
    media_type,
    media_thumbnail,
    media_width,
    media_height,
    media_duration,
    media_size,
    media_mime_type,
  } = message;

  // Require either content or media
  const hasContent = content && content.trim().length > 0;
  const hasMedia = media_url && media_type;
  if (!conversationId || (!hasContent && !hasMedia)) return;
  if (content && content.length > 5000) return;

  try {
    // Save to database (with optional media fields)
    const savedMessage = await db.createMessage({
      conversation_id: conversationId,
      sender_id: userId,
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

        // Push notification — show media type if no text
        const pushText = hasContent
          ? content.trim()
          : media_type === "video"
            ? "Video"
            : "Photo";
        await sendMessagePush(
          participantId,
          userName,
          pushText,
          conversationId,
        );
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

// ─── World Chat Typing ─────────────────────────────────────────────────────────
function handleWorldTyping(userId, userName, ws, wss) {
  // Broadcast to all other connected clients
  wss.clients.forEach((client) => {
    if (client !== ws && client.readyState === 1) {
      client.send(
        JSON.stringify({
          type: "world-typing",
          userId,
          userName,
        }),
      );
    }
  });
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
  const {
    content,
    tempId,
    media_url,
    media_type,
    media_thumbnail,
    media_width,
    media_height,
    media_duration,
    media_size,
    media_mime_type,
  } = message;

  const hasContent = content && content.trim().length > 0;
  const hasMedia = media_url && media_type;
  if (!hasContent && !hasMedia) return;
  if (content && content.length > 1000) return;

  try {
    const user = await db.getUserById(userId);
    const savedMessage = await db.createWorldMessage({
      sender_id: userId,
      sender_name: userName,
      sender_avatar: user?.avatar_url || user?.avatar_seed || userId,
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

    // ── @mention detection + notification ──────────────────────────────
    const mentionRegex = /@(\w+)/g;
    let match;
    const mentionedNames = new Set();
    while ((match = mentionRegex.exec(content)) !== null) {
      mentionedNames.add(match[1].toLowerCase());
    }

    if (mentionedNames.size > 0) {
      // Look up all users to find matches (batch for efficiency)
      for (const mentionName of mentionedNames) {
        try {
          const results = await db.searchUsers(mentionName, 5, 0);
          for (const mentionedUser of results) {
            if (
              mentionedUser.id !== userId &&
              mentionedUser.name.toLowerCase() === mentionName
            ) {
              // 5-minute aggregation bucket
              const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
              const groupKey = `world_mention:${mentionedUser.id}:${bucket}`;

              const notification = await db.createNotification({
                user_id: mentionedUser.id,
                type: "world_mention",
                title: "Mentioned in World Chat",
                body: `${userName} mentioned you in World Chat`,
                data: {
                  sender_id: userId,
                  sender_name: userName,
                  message_id: savedMessage.id,
                },
                priority: 0,
                group_key: groupKey,
              });

              // Update body if aggregated
              if (notification.data?.count > 1) {
                notification.body = `You were mentioned ${notification.data.count} times in World Chat`;
              }

              // Real-time push
              presence
                .sendToUser(mentionedUser.id, {
                  type: "notification:new",
                  notification,
                })
                .catch(() => {});
            }
          }
        } catch (mentionErr) {
          console.error("Mention notification error:", mentionErr.message);
        }
      }
    }
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

// ─── World Video Chat Handlers ────────────────────────────────────────────────

async function handleWorldJoin(userId, ws) {
  try {
    const result = await matchmaking.joinQueue(userId);

    if (!result) {
      // No match available — user is queued, waiting for partner
      console.log(`[WORLD_JOIN] userId=${userId} status=searching`);
      ws.send(JSON.stringify({
        type: "world-queue-status",
        status: "searching",
        message: "Looking for someone to chat with...",
      }));
      return;
    }

    if (result.alreadyQueued) {
      console.log(`[WORLD_JOIN] userId=${userId} status=already_queued`);
      ws.send(JSON.stringify({
        type: "world-queue-status",
        status: "already_queued",
        message: "Already in queue",
      }));
      return;
    }

    if (result.alreadyMatched) {
      // User already has an active session — re-send match info
      console.log(`[WORLD_JOIN] userId=${userId} status=already_matched sessionId=${result.sessionId}`);

      // World video is anonymous by default: never reveal real name/avatar here.
      const peerProfile = {
        displayName: "Anonymous",
        isPrivate: true,
        avatarUrl: null,
        avatarSeed: null,
      };

      ws.send(JSON.stringify({
        type: "world-matched",
        sessionId: result.sessionId,
        peerToken: result.peerToken,
        role: result.role,
        expiresAt: result.expiresAt,
        peerProfile,
      }));
      return;
    }

    // ★ Defense-in-depth: verify this user is actually part of the match.
    // With the matchmaking fix, joinQueue should ONLY return matches involving userId.
    // But if somehow it doesn't, don't leave the user in limbo.
    if (result.user1 !== userId && result.user2 !== userId) {
      console.error(`[WORLD_JOIN_BUG] userId=${userId} received match not involving them: sessionId=${result.sessionId} user1=${result.user1} user2=${result.user2}`);
      // Notify the matched users correctly
      await matchmaking._notifyMatchedUsers(result);
      // Send searching status to this user (they're still in queue)
      ws.send(JSON.stringify({
        type: "world-queue-status",
        status: "searching",
        message: "Looking for someone to chat with...",
      }));
      return;
    }

    // New match found involving this user — notify both users
    console.log(`[WORLD_JOIN] userId=${userId} status=matched sessionId=${result.sessionId}`);
    await matchmaking._notifyMatchedUsers(result);
  } catch (err) {
    console.error("World join error:", err.message);
    ws.send(JSON.stringify({
      type: "world-error",
      code: "JOIN_ERROR",
      message: "Failed to join queue",
    }));
  }
}

async function handleWorldLeave(userId, message) {
  try {
    const sessionIdHint = message?.sessionId;
    await matchmaking.leaveWorldVideo(userId, { sessionIdHint });
  } catch (err) {
    console.error("World leave error:", err.message);
  }
}

async function handleWorldNext(userId, message) {
  try {
    const { sessionId } = message;

    // Rate limit check
    const rateLimit = await matchmaking.checkNextRateLimit(userId);
    if (!rateLimit.allowed) {
      // Send rate limit response via presence (guaranteed delivery)
      await presence.sendToUser(userId, {
        type: "world-rate-limited",
        retryAfter: rateLimit.retryAfter,
      });
      return;
    }

    // Set rate limit
    await matchmaking.setNextRateLimit(userId);

    // End current session. Clients decide whether to re-queue based on {requeue:true}.
    if (sessionId) {
      const userState = await matchmaking.getUserSession(userId);
      if (!userState || userState.sessionId !== sessionId) {
        await presence.sendToUser(userId, {
          type: "world-error",
          code: "UNAUTHORIZED_SESSION",
          message: "Invalid session for Next",
        });
        return;
      }

      await matchmaking.endSession(sessionId, "next", userId);
    } else {
      // No session — just re-queue
      await matchmaking.joinQueue(userId);
    }
  } catch (err) {
    console.error("World next error:", err.message);
    await presence.sendToUser(userId, {
      type: "world-error",
      code: "NEXT_ERROR",
      message: "Failed to skip",
    });
  }
}

async function handleWorldVideoOffer(userId, message) {
  const { sessionId, sdp, fromToken } = message;
  if (!sessionId || !sdp) return;

  // Get session to find peer
  const session = await matchmaking.getSession(sessionId);
  if (!session) return;

  // Determine peer (userId uses ephemeral token for identification)
  const userState = await matchmaking.getUserSession(userId);
  if (!userState || userState.sessionId !== sessionId) return;

  const peerId = session.user1 === userId ? session.user2 : session.user1;

  // Forward offer to peer, replacing fromUserId with fromToken for privacy
  await presence.sendToUser(peerId, {
    type: "world-video-offer",
    sessionId,
    sdp,
    fromToken: fromToken || userState.ephemeralToken,
  });
}

async function handleWorldVideoAnswer(userId, message) {
  const { sessionId, sdp, fromToken } = message;
  if (!sessionId || !sdp) return;

  const session = await matchmaking.getSession(sessionId);
  if (!session) return;

  const userState = await matchmaking.getUserSession(userId);
  if (!userState || userState.sessionId !== sessionId) return;

  const peerId = session.user1 === userId ? session.user2 : session.user1;

  await presence.sendToUser(peerId, {
    type: "world-video-answer",
    sessionId,
    sdp,
    fromToken: fromToken || userState.ephemeralToken,
  });
}

async function handleWorldVideoIceCandidate(userId, message) {
  const { sessionId, candidate, fromToken } = message;
  if (!sessionId || !candidate) return;

  const session = await matchmaking.getSession(sessionId);
  if (!session) return;

  const userState = await matchmaking.getUserSession(userId);
  if (!userState || userState.sessionId !== sessionId) return;

  const peerId = session.user1 === userId ? session.user2 : session.user1;

  await presence.sendToUser(peerId, {
    type: "world-video-ice-candidate",
    sessionId,
    candidate,
    fromToken: fromToken || userState.ephemeralToken,
  });
}

async function handleWorldVideoIceRestart(userId, message) {
  const { sessionId, sdp, fromToken } = message;
  if (!sessionId || !sdp) return;

  const session = await matchmaking.getSession(sessionId);
  if (!session) return;

  const userState = await matchmaking.getUserSession(userId);
  if (!userState || userState.sessionId !== sessionId) return;

  const peerId = session.user1 === userId ? session.user2 : session.user1;

  await presence.sendToUser(peerId, {
    type: "world-video-ice-restart",
    sessionId,
    sdp,
    fromToken: fromToken || userState.ephemeralToken,
  });
}

// ★ Camera state relay (Bug 5 fix)
async function handleWorldVideoCameraState(userId, message) {
  const { sessionId, cameraOn } = message;
  if (!sessionId || cameraOn === undefined) return;

  const session = await matchmaking.getSession(sessionId);
  if (!session) return;

  const userState = await matchmaking.getUserSession(userId);
  if (!userState || userState.sessionId !== sessionId) return;

  const peerId = session.user1 === userId ? session.user2 : session.user1;

  console.log(`[CAMERA_STATE] sessionId=${sessionId} userId=${userId} cameraOn=${cameraOn}`);

  await presence.sendToUser(peerId, {
    type: "world-video-camera-state",
    sessionId,
    cameraOn,
  });
}

module.exports = { initializeSignaling, activeCalls };
