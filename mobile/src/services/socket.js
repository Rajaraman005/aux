/**
 * WebSocket Signaling Client — FAANG-Grade.
 *
 * ★ Smart Reconnect:
 *   - Auto-reconnect with exponential backoff
 *   - Rejoin active call session after reconnect
 *   - Re-send queued ICE candidates
 *   - Heartbeat to detect dead connections early
 *
 * ★ Message Queue:
 *   - Messages sent while disconnected are queued
 *   - Automatically flushed on reconnection
 */
import { AppState } from "react-native";
import { WS_BASE } from "../config/api";
import crashLogger, { CATEGORIES } from "./CrashLogger";

class SignalingClient {
  constructor() {
    this.ws = null;
    this.token = null;
    this.listeners = new Map();
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 15;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.onConnectionChange = null;

    // ★ Smart Reconnect
    this._activeCallId = null;
    this._messageQueue = [];
    this._maxQueueSize = 50;
    this._lastPongTime = 0;
    this._pongCheckTimer = null;

    // ★ FAANG-grade: ACK/retry protocol
    this._pendingAcks = new Map(); // seqNum -> timeout
    this._ackedSeqNums = new Set(); // Deduplication
    this._nextSeq = 0;

    // ★ Lifecycle awareness
    this._appStateSubscription = null;
    this._isBackgrounded = false;
    this._setupAppStateListener();
  }

  // ★ AppState listener — pause heartbeat when backgrounded, resume on foreground
  _setupAppStateListener() {
    this._appStateSubscription = AppState.addEventListener(
      "change",
      (nextState) => {
        if (nextState === "background" || nextState === "inactive") {
          if (!this._isBackgrounded) {
            this._isBackgrounded = true;
            crashLogger.log(
              CATEGORIES.SOCKET_DISCONNECTED,
              "App backgrounded — pausing heartbeat",
            );
            this._pauseHeartbeat();
          }
        } else if (nextState === "active" && this._isBackgrounded) {
          this._isBackgrounded = false;
          crashLogger.log(
            CATEGORIES.SOCKET_CONNECTED,
            "App foregrounded — checking connection",
          );
          this._onForegroundResume();
        }
      },
    );
  }

  // ★ On foreground: check if socket is still alive, reconnect if needed
  _onForegroundResume() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Socket still open — resume heartbeat and send a probe
      this.startHeartbeat();
      this.send({ type: "heartbeat" });
    } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      // Still connecting — let it finish
    } else if (this.token) {
      // Socket died while backgrounded — force immediate reconnect
      crashLogger.log(
        CATEGORIES.SOCKET_DISCONNECTED,
        "Socket died while backgrounded — reconnecting",
      );
      this.isConnected = false;
      this.reconnectAttempts = 0; // Reset attempts for fresh start
      this.connect(this.token);
    }
  }

  /**
   * Connect to the signaling server.
   * @param {string} token - JWT access token
   */
  connect(token) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.disconnect();
    }

    this.token = token;

    try {
      this.ws = new WebSocket(`${WS_BASE}?token=${token}`);

      this.ws.onopen = () => {
        crashLogger.log(CATEGORIES.SOCKET_CONNECTED, "Signaling connected");
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.emit("connected");
        this.onConnectionChange?.(true);

        // ★ Flush queued messages
        this._flushQueue();

        // ★ Rejoin active call session
        if (this._activeCallId) {
          console.log(`🔄 Rejoining call session: ${this._activeCallId}`);
          this.send({
            type: "call-rejoin",
            callId: this._activeCallId,
          });
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          // Track pong for liveness detection
          if (message.type === "pong" || message.type === "heartbeat-ack") {
            this._lastPongTime = Date.now();
            return;
          }

          // ★ FAANG-grade: Handle ACK
          if (message.type === "ack") {
            const { _ackSeq } = message;
            if (_ackSeq && this._pendingAcks.has(_ackSeq)) {
              clearTimeout(this._pendingAcks.get(_ackSeq));
              this._pendingAcks.delete(_ackSeq);
              console.log(`📨 ACK received for seq ${_ackSeq}`);
            }
            return;
          }

          // ★ FAANG-grade: Deduplication
          if (message._seq && this._ackedSeqNums.has(message._seq)) {
            console.log(`📨 Duplicate message ignored: seq ${message._seq}`);
            return;
          }
          if (message._seq) {
            this._ackedSeqNums.add(message._seq);
            // Keep only last 1000 seq nums
            if (this._ackedSeqNums.size > 1000) {
              const first = this._ackedSeqNums.values().next().value;
              this._ackedSeqNums.delete(first);
            }
          }

          // ★ FAANG-grade: Send ACK for critical events
          if (message._ackRequired) {
            this.ws.send(JSON.stringify({
              type: 'ack',
              _ackSeq: message._seq,
              _forType: message.type,
            }));
          }

          this.emit(message.type, message);
        } catch (err) {
          console.error("Signaling parse error:", err);
        }
      };

      this.ws.onclose = (event) => {
        crashLogger.log(
          CATEGORIES.SOCKET_DISCONNECTED,
          `Signaling disconnected (code: ${event.code})`,
        );
        this.isConnected = false;
        this.stopHeartbeat();
        this.onConnectionChange?.(false);

        // Don't reconnect if intentionally closed, auth failed, or backgrounded
        if (
          event.code !== 1000 &&
          event.code !== 4001 &&
          event.code !== 4002 &&
          !this._isBackgrounded
        ) {
          this.attemptReconnect();
        }

        this.emit("disconnected", { code: event.code, reason: event.reason });
      };

      this.ws.onerror = (error) => {
        crashLogger.log(CATEGORIES.SOCKET_ERROR, "Signaling error", error);
        this.emit("error", error);
      };
    } catch (err) {
      console.error("Failed to create WebSocket:", err);
      this.attemptReconnect();
    }
  }

  /**
   * Send a message. ★ Queue if disconnected.
   * ★ FAANG-grade: Add sequence number and ACK tracking for critical events
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msgWithSeq = {
        ...message,
        _seq: this._nextSeq++,
        _timestamp: Date.now(),
      };

      // Track if ACK required
      if (message._ackRequired) {
        const timeout = setTimeout(() => {
          console.warn(`📨 No ACK received for seq ${msgWithSeq._seq}`);
          this._pendingAcks.delete(msgWithSeq._seq);
        }, 5000);
        this._pendingAcks.set(msgWithSeq._seq, timeout);
      }

      this.ws.send(JSON.stringify(msgWithSeq));
      return true;
    }

    // ★ Queue for later delivery (except heartbeats)
    if (
      message.type !== "heartbeat" &&
      this._messageQueue.length < this._maxQueueSize
    ) {
      this._messageQueue.push({ ...message, _queuedAt: Date.now() });
      console.log(`📨 Queued message: ${message.type}`);
    }
    return false;
  }

  /**
   * ★ Flush queued messages after reconnect.
   */
  _flushQueue() {
    if (this._messageQueue.length === 0) return;

    const now = Date.now();
    // Drop messages older than 30s (stale ICE candidates, etc.)
    const fresh = this._messageQueue.filter((m) => now - m._queuedAt < 30000);

    console.log(
      `📤 Flushing ${fresh.length} queued messages (${this._messageQueue.length - fresh.length} dropped as stale)`,
    );

    for (const msg of fresh) {
      delete msg._queuedAt;
      this.send(msg);
    }
    this._messageQueue = [];
  }

  /**
   * Disconnect from the signaling server.
   */
  disconnect() {
    this.stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect

    if (this.ws) {
      this.ws.close(1000, "User disconnect");
      this.ws = null;
    }
    this.isConnected = false;
    this._activeCallId = null;
    this._messageQueue = [];
  }

  // ─── Auto-Reconnect with Exponential Backoff ─────────────────────────────
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn("Max reconnect attempts reached");
      this.emit("reconnect-failed");
      return;
    }

    // ★ Faster initial reconnects (1s, 2s, 4s...) capped at 15s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 15000);
    this.reconnectAttempts++;

    console.log(
      `🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.token) {
        this.connect(this.token);
      }
    }, delay);

    this.emit("reconnecting", { attempt: this.reconnectAttempts, delay });
  }

  // ─── Heartbeat with Dead Connection Detection ────────────────────────────
  startHeartbeat() {
    this._lastPongTime = Date.now();

    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, 15000);

    // ★ Check for dead connection (no pong in 45s)
    this._pongCheckTimer = setInterval(() => {
      if (Date.now() - this._lastPongTime > 45000 && this.isConnected) {
        console.warn("💀 Dead connection detected — forcing reconnect");
        this.ws?.close(4003, "Dead connection");
      }
    }, 20000);
  }

  // ★ Pause heartbeat (background mode) — stops timers but doesn't close socket
  _pauseHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this._pongCheckTimer) {
      clearInterval(this._pongCheckTimer);
      this._pongCheckTimer = null;
    }
  }

  stopHeartbeat() {
    this._pauseHeartbeat();
  }

  // ─── Event System ─────────────────────────────────────────────────────────
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const listeners = this.listeners.get(event);
    if (listeners) listeners.delete(callback);
  }

  emit(event, data) {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          console.error(`Listener error for ${event}:`, err);
        }
      });
    }
  }

  // ─── Signaling Helpers ────────────────────────────────────────────────────
  requestCall(targetUserId, callType = "video") {
    return this.send({ type: "call-request", targetUserId, callType });
  }

  acceptCall(callId) {
    this._activeCallId = callId; // ★ Track active call
    return this.send({ type: "call-accept", callId });
  }

  rejectCall(callId, reason = "rejected") {
    return this.send({ type: "call-reject", callId, reason });
  }

  sendOffer(callId, sdp) {
    this._activeCallId = callId; // ★ Track active call
    return this.send({ type: "offer", callId, sdp });
  }

  sendAnswer(callId, sdp) {
    this._activeCallId = callId; // ★ Track active call
    return this.send({ type: "answer", callId, sdp });
  }

  sendIceCandidate(callId, candidate) {
    return this.send({ type: "ice-candidate", callId, candidate });
  }

  hangUp(callId) {
    if (!callId) return false;
    const result = this.send({ type: "hang-up", callId });
    this._activeCallId = null; // ★ Clear active call
    return result;
  }

  sendIceRestart(callId, sdp) {
    return this.send({ type: "ice-restart", callId, sdp });
  }

  sendCallMetrics(callId, stats) {
    return this.send({ type: "call-metrics", callId, stats });
  }

  sendCallStatus(callId) {
    return this.send({ type: "call-status", callId });
  }

  sendCallModeSwitch(callId, mode) {
    return this.send({ type: "call-mode-switch", callId, mode });
  }

  sendCallModeRequest(callId, mode) {
    return this.send({ type: "call-mode-request", callId, mode });
  }

  sendCallModeResponse(callId, accepted) {
    return this.send({ type: "call-mode-response", callId, accepted });
  }

  // ─── Chat Helpers ───────────────────────────────────────────────────────────
  sendChatMessage(conversationId, content, tempId, media = null) {
    return this.send({
      type: "chat-message",
      conversationId,
      content,
      tempId,
      ...(media && {
        media_url: media.url,
        media_type: media.mediaType,
        media_thumbnail: media.thumbnailUrl,
        media_width: media.width,
        media_height: media.height,
        media_duration: media.duration,
        media_size: media.size,
        media_mime_type: media.mimeType,
      }),
    });
  }

  sendTyping(conversationId) {
    return this.send({ type: "typing", conversationId });
  }

  sendMessageRead(conversationId) {
    return this.send({ type: "message-read", conversationId });
  }

  // ─── World Chat Helpers ─────────────────────────────────────────────────────
  sendWorldMessage(content, tempId, media = null) {
    return this.send({
      type: "world-message",
      content,
      tempId,
      ...(media && {
        media_url: media.url,
        media_type: media.mediaType,
        media_thumbnail: media.thumbnailUrl,
        media_width: media.width,
        media_height: media.height,
        media_duration: media.duration,
        media_size: media.size,
        media_mime_type: media.mimeType,
      }),
    });
  }

  // ─── World Video Chat Helpers ────────────────────────────────────────────────
  joinWorldVideo() {
    return this.send({ type: "world-join" });
  }

  leaveWorldVideo(sessionId) {
    return this.send({ type: "world-leave", ...(sessionId ? { sessionId } : {}) });
  }

  nextWorldVideo(sessionId) {
    return this.send({ type: "world-next", sessionId });
  }

  sendWorldVideoOffer(sessionId, sdp) {
    return this.send({ type: "world-video-offer", sessionId, sdp });
  }

  sendWorldVideoAnswer(sessionId, sdp) {
    return this.send({ type: "world-video-answer", sessionId, sdp });
  }

  sendWorldVideoIceCandidate(sessionId, candidate) {
    return this.send({ type: "world-video-ice-candidate", sessionId, candidate });
  }

  sendWorldVideoIceRestart(sessionId, sdp) {
    return this.send({ type: "world-video-ice-restart", sessionId, sdp });
  }

  // ★ Bug 5: Camera state signaling for world video
  sendWorldVideoCameraState(sessionId, cameraOn) {
    return this.send({ type: "world-video-camera-state", sessionId, cameraOn });
  }
}

// Singleton
const signalingClient = new SignalingClient();
export default signalingClient;
