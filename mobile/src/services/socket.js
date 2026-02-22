/**
 * WebSocket Signaling Client.
 * Connects to the signaling server with JWT auth.
 * Features: auto-reconnect, heartbeat, event-driven messaging.
 */
import { WS_BASE } from "../config/api";

class SignalingClient {
  constructor() {
    this.ws = null;
    this.token = null;
    this.listeners = new Map();
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.onConnectionChange = null;
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
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
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
   * Send a message to the signaling server.
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    console.warn("Cannot send — WebSocket not connected");
    return false;
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
  }

  // ─── Auto-Reconnect with Exponential Backoff ─────────────────────────────
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn("Max reconnect attempts reached");
      this.emit("reconnect-failed");
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
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

  // ─── Heartbeat ────────────────────────────────────────────────────────────
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, 25000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
    return this.send({ type: "call-accept", callId });
  }

  rejectCall(callId, reason = "rejected") {
    return this.send({ type: "call-reject", callId, reason });
  }

  sendOffer(callId, sdp) {
    return this.send({ type: "offer", callId, sdp });
  }

  sendAnswer(callId, sdp) {
    return this.send({ type: "answer", callId, sdp });
  }

  sendIceCandidate(callId, candidate) {
    return this.send({ type: "ice-candidate", callId, candidate });
  }

  hangUp(callId) {
    return this.send({ type: "hang-up", callId });
  }

  sendIceRestart(callId, sdp) {
    return this.send({ type: "ice-restart", callId, sdp });
  }

  sendCallMetrics(callId, stats) {
    return this.send({ type: "call-metrics", callId, stats });
  }
}

// Singleton
const signalingClient = new SignalingClient();
export default signalingClient;
