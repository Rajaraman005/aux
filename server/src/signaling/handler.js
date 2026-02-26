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
const {
  sendMessagePush,
  sendCallPush,
  sendMissedCallPush,
} = require("../services/pushService");

// Active calls: callId -> { callerId, calleeId, startedAt, state }
const activeCalls = new Map();

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
    metrics.activeConnections.inc();

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

      await presence.userDisconnected(userId);
      metrics.activeConnections.dec();
      console.log(`🔴 ${userName} (${userId}) disconnected`);

      // ★ Check if this user has any active calls
      let hasActiveCalls = false;
      for (const [, call] of activeCalls) {
        if (
          call.state !== "ended" &&
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
        console.log(
          `⏳ ${userName} (${userId}) has active calls — waiting ${GRACE_PERIOD_MS / 1000}s before cleanup`,
        );

        const timer = setTimeout(async () => {
          disconnectTimers.delete(userId);

          // Check if user reconnected during grace period
          const isBackOnline = await presence.isOnline(userId);
          if (isBackOnline) {
            console.log(
              `✅ ${userName} (${userId}) is back online — skipping call cleanup`,
            );
            return;
          }

          // User did NOT reconnect — clean up their calls
          console.log(
            `❌ ${userName} (${userId}) did not reconnect — cleaning up calls`,
          );
          for (const [callId, call] of activeCalls) {
            if (
              call.state !== "ended" &&
              (call.callerId === userId || call.calleeId === userId)
            ) {
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
        }, GRACE_PERIOD_MS);

        disconnectTimers.set(userId, timer);
      }
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

  // Get caller's avatar
  const user = await db.getUserById(callerId);
  const callerAvatar = user?.avatar_url || user?.avatar_seed || callerId;

  // ★ Check if either party is already in a call (BEFORE creating new call)
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

  // ★ Create call FIRST — before checking online status
  // This ensures the call exists for push-woken users to join
  const callId = uuidv4();
  const callData = {
    callerId,
    calleeId: targetUserId,
    callerName,
    callerAvatar,
    callType,
    startedAt: Date.now(),
    state: "ringing",
    // ★ Track whether callee was woken via push (for logging/metrics)
    pushWakeUp: false,
  };
  activeCalls.set(callId, callData);
  metrics.activeCalls.inc();

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

  // ★ Validate: only forward offer in connecting/active states
  if (!call || call.state === "ended" || call.state === "ringing") return;

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

  // ★ Validate: only accept answer when connecting
  if (!call || call.state === "ended") return;

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

async function handleHangUp(userId, message) {
  const { callId } = message;
  const call = activeCalls.get(callId);

  // ★ Guard against already-ended or missing calls
  if (!call || call.state === "ended") return;

  const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
  await presence.sendToUser(otherUserId, {
    type: "call-ended",
    callId,
    reason: "hang_up",
  });

  await finalizeCall(callId, "normal");
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
  const { callId } = message;
  const call = activeCalls.get(callId);

  if (!call || call.state === "ended") {
    ws.send(
      JSON.stringify({
        type: "call-rejoin-response",
        callId,
        success: false,
        reason: "call_not_found",
      }),
    );
    return;
  }

  // Verify user is part of this call
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

  // ★ Re-register presence so signaling messages route to the new WS
  await presence.userConnected(userId, ws);

  ws.send(
    JSON.stringify({
      type: "call-rejoin-response",
      callId,
      success: true,
      state: call.state,
      callType: call.callType,
    }),
  );

  console.log(`🔄 ${userId} rejoined call ${callId} (state: ${call.state})`);
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
  // ★ Guard against double-finalization
  if (!call || call.state === "ended") return;

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

module.exports = { initializeSignaling, activeCalls };
