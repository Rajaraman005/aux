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
import { WS_BASE } from "../config/api";

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
        console.log("🟢 Signaling connected");
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

          this.emit(message.type, message);
        } catch (err) {
          console.error("Signaling parse error:", err);
        }
      };

      this.ws.onclose = (event) => {
        console.log(`🔴 Signaling disconnected (code: ${event.code})`);
        this.isConnected = false;
        this.stopHeartbeat();
        this.onConnectionChange?.(false);

        // Don't reconnect if intentionally closed or auth failed
        if (event.code !== 1000 && event.code !== 4001 && event.code !== 4002) {
          this.attemptReconnect();
        }

        this.emit("disconnected", { code: event.code, reason: event.reason });
      };

      this.ws.onerror = (error) => {
        console.error("Signaling error:", error.message);
        this.emit("error", error);
      };
    } catch (err) {
      console.error("Failed to create WebSocket:", err);
      this.attemptReconnect();
    }
  }

  /**
   * Send a message. ★ Queue if disconnected.
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
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

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this._pongCheckTimer) {
      clearInterval(this._pongCheckTimer);
      this._pongCheckTimer = null;
    }
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
  requestCall(targetUserId) {
    return this.send({ type: "call-request", targetUserId });
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

  // ─── Chat Helpers ───────────────────────────────────────────────────────────
  sendChatMessage(conversationId, content, tempId) {
    return this.send({ type: "chat-message", conversationId, content, tempId });
  }

  sendTyping(conversationId) {
    return this.send({ type: "typing", conversationId });
  }

  sendMessageRead(conversationId) {
    return this.send({ type: "message-read", conversationId });
  }
}

// Singleton
const signalingClient = new SignalingClient();
export default signalingClient;
