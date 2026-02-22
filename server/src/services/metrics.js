/**
 * Prometheus Metrics Exporter.
 * Exposes /metrics endpoint for Prometheus scraping.
 * Tracks: connections, signaling latency, call quality, failures.
 */
const client = require("prom-client");
const config = require("../config");

// Create a Registry
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop lag)
client.collectDefaultMetrics({ register, prefix: "videocall_" });

// ─── Custom Metrics ──────────────────────────────────────────────────────────

const activeConnections = new client.Gauge({
  name: "videocall_active_ws_connections",
  help: "Number of active WebSocket connections",
  registers: [register],
});

const activeCalls = new client.Gauge({
  name: "videocall_active_calls",
  help: "Number of ongoing calls",
  registers: [register],
});

const signalingLatency = new client.Histogram({
  name: "videocall_signaling_latency_ms",
  help: "Signaling message processing latency in milliseconds",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

const callDuration = new client.Histogram({
  name: "videocall_call_duration_seconds",
  help: "Call duration in seconds",
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [register],
});

const callFailures = new client.Counter({
  name: "videocall_call_failures_total",
  help: "Total call failures by reason",
  labelNames: ["reason"],
  registers: [register],
});

const packetLoss = new client.Histogram({
  name: "videocall_packet_loss_percent",
  help: "Reported packet loss percentage",
  buckets: [0.5, 1, 2, 5, 10, 15, 20, 30, 50],
  registers: [register],
});

const jitter = new client.Histogram({
  name: "videocall_jitter_ms",
  help: "Reported jitter in milliseconds",
  buckets: [5, 10, 20, 30, 50, 100, 200, 500],
  registers: [register],
});

const rtt = new client.Histogram({
  name: "videocall_rtt_ms",
  help: "Round-trip time in milliseconds",
  buckets: [10, 25, 50, 100, 150, 200, 300, 500, 1000],
  registers: [register],
});

const sfuFallbacks = new client.Counter({
  name: "videocall_sfu_fallbacks_total",
  help: "Number of times calls fell back to SFU relay",
  registers: [register],
});

const modeSwitches = new client.Counter({
  name: "videocall_mode_switches_total",
  help: "Total video-to-audio mode switches",
  labelNames: ["direction"], // 'to_audio_only', 'to_video'
  registers: [register],
});

const authAttempts = new client.Counter({
  name: "videocall_auth_attempts_total",
  help: "Authentication attempts by result",
  labelNames: ["action", "result"], // action: login/signup, result: success/failure
  registers: [register],
});

const metrics = {
  register,
  activeConnections,
  activeCalls,
  signalingLatency,
  callDuration,
  callFailures,
  packetLoss,
  jitter,
  rtt,
  sfuFallbacks,
  modeSwitches,
  authAttempts,
};

module.exports = metrics;
