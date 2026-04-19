/**
 * FAANG-grade Prometheus Metrics Exporter.
 * Exposes /metrics endpoint for Prometheus scraping.
 * Tracks: connections, signaling latency, call quality, failures,
 * state transitions, delivery guarantees, heartbeats, Redis operations.
 */
const client = require("prom-client");
const config = require("../config");

// Get pod ID for labeling
const podId = process.env.POD_ID || `pod-${process.pid}-${Date.now()}`;

// Create a Registry
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop lag)
client.collectDefaultMetrics({ register, prefix: "webrtc_" });

// Common labels for all metrics
const commonLabels = {
  pod: podId,
  env: config.env,
};

// ─── Call Lifecycle Metrics ─────────────────────────────────────────────────

const callStateTransitions = new client.Counter({
  name: "webrtc_call_state_transitions_total",
  help: "Total call state transitions",
  labelNames: ["from_state", "to_state", "pod", "env"],
  registers: [register],
});

const callDuration = new client.Histogram({
  name: "webrtc_call_duration_seconds",
  help: "Call duration in seconds",
  labelNames: ["outcome", "pod", "env"],
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [register],
});

const activeCalls = new client.Gauge({
  name: "webrtc_active_calls",
  help: "Number of ongoing calls",
  labelNames: ["pod", "env"],
  registers: [register],
});

const ghostConnections = new client.Counter({
  name: "webrtc_ghost_connections_total",
  help: "Total ghost connections detected",
  labelNames: ["pod", "env"],
  registers: [register],
});

// ─── Delivery Metrics ───────────────────────────────────────────────────────

const criticalEventsSent = new client.Counter({
  name: "webrtc_critical_events_sent_total",
  help: "Total critical events sent",
  labelNames: ["event_type", "pod", "env"],
  registers: [register],
});

const criticalEventsAcked = new client.Counter({
  name: "webrtc_critical_events_acked_total",
  help: "Total critical events acknowledged",
  labelNames: ["event_type", "pod", "env"],
  registers: [register],
});

const criticalEventsRetry = new client.Counter({
  name: "webrtc_critical_events_retry_total",
  help: "Total critical event retries",
  labelNames: ["event_type", "pod", "env"],
  registers: [register],
});

const messageDeliveryLatency = new client.Histogram({
  name: "webrtc_message_delivery_latency_seconds",
  help: "Message delivery latency in seconds",
  labelNames: ["event_type", "pod", "env"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// ─── Heartbeat Metrics ───────────────────────────────────────────────────────

const heartbeatReceived = new client.Counter({
  name: "webrtc_heartbeat_received_total",
  help: "Total heartbeats received",
  labelNames: ["pod", "env"],
  registers: [register],
});

const heartbeatTimeout = new client.Counter({
  name: "webrtc_heartbeat_timeout_total",
  help: "Total heartbeat timeouts",
  labelNames: ["pod", "env"],
  registers: [register],
});

const staleCallsDetected = new client.Counter({
  name: "webrtc_stale_calls_detected_total",
  help: "Total stale calls detected",
  labelNames: ["pod", "env"],
  registers: [register],
});

// ─── Connection Metrics ─────────────────────────────────────────────────────

const activeConnections = new client.Gauge({
  name: "webrtc_websocket_connections",
  help: "Number of active WebSocket connections",
  labelNames: ["pod", "env"],
  registers: [register],
});

const websocketReconnect = new client.Counter({
  name: "webrtc_websocket_reconnect_total",
  help: "Total WebSocket reconnections",
  labelNames: ["pod", "env"],
  registers: [register],
});

// ─── Redis Metrics ─────────────────────────────────────────────────────────

const redisOperations = new client.Histogram({
  name: "webrtc_redis_operations_duration_seconds",
  help: "Redis operation duration in seconds",
  labelNames: ["operation", "pod", "env"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

const redisErrors = new client.Counter({
  name: "webrtc_redis_errors_total",
  help: "Total Redis errors",
  labelNames: ["operation", "error_type", "pod", "env"],
  registers: [register],
});

const redisCircuitBreakerState = new client.Gauge({
  name: "webrtc_redis_circuit_breaker_state",
  help: "Redis circuit breaker state (0=closed, 1=open, 2=half-open)",
  labelNames: ["pod", "env"],
  registers: [register],
});

// ─── Existing Metrics (Enhanced with pod labels) ───────────────────────────

const signalingLatency = new client.Histogram({
  name: "webrtc_signaling_latency_ms",
  help: "Signaling message processing latency in milliseconds",
  labelNames: ["pod", "env"],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

const callFailures = new client.Counter({
  name: "webrtc_call_failures_total",
  help: "Total call failures by reason",
  labelNames: ["reason", "pod", "env"],
  registers: [register],
});

const packetLoss = new client.Histogram({
  name: "webrtc_packet_loss_percent",
  help: "Reported packet loss percentage",
  labelNames: ["pod", "env"],
  buckets: [0.5, 1, 2, 5, 10, 15, 20, 30, 50],
  registers: [register],
});

const jitter = new client.Histogram({
  name: "webrtc_jitter_ms",
  help: "Reported jitter in milliseconds",
  labelNames: ["pod", "env"],
  buckets: [5, 10, 20, 30, 50, 100, 200, 500],
  registers: [register],
});

const rtt = new client.Histogram({
  name: "webrtc_rtt_ms",
  help: "Round-trip time in milliseconds",
  labelNames: ["pod", "env"],
  buckets: [10, 25, 50, 100, 150, 200, 300, 500, 1000],
  registers: [register],
});

const sfuFallbacks = new client.Counter({
  name: "webrtc_sfu_fallbacks_total",
  help: "Number of times calls fell back to SFU relay",
  labelNames: ["pod", "env"],
  registers: [register],
});

const modeSwitches = new client.Counter({
  name: "webrtc_mode_switches_total",
  help: "Total video-to-audio mode switches",
  labelNames: ["direction", "pod", "env"],
  registers: [register],
});

const authAttempts = new client.Counter({
  name: "webrtc_auth_attempts_total",
  help: "Authentication attempts by result",
  labelNames: ["action", "result", "pod", "env"],
  registers: [register],
});

// Helper function to add common labels
function addCommonLabels(labels = {}) {
  return { ...labels, pod: podId, env: config.env };
}

const metrics = {
  register,
  podId,
  
  // Call lifecycle
  callStateTransitions: (from, to) => callStateTransitions.inc(addCommonLabels({ from_state: from, to_state: to })),
  callDuration: (duration, outcome) => callDuration.observe(addCommonLabels({ outcome }), duration),
  activeCalls: (count) => activeCalls.set(addCommonLabels(), count),
  ghostConnections: () => ghostConnections.inc(addCommonLabels()),
  
  // Delivery
  criticalEventsSent: (eventType) => criticalEventsSent.inc(addCommonLabels({ event_type: eventType })),
  criticalEventsAcked: (eventType) => criticalEventsAcked.inc(addCommonLabels({ event_type: eventType })),
  criticalEventsRetry: (eventType) => criticalEventsRetry.inc(addCommonLabels({ event_type: eventType })),
  messageDeliveryLatency: (eventType, duration) => messageDeliveryLatency.observe(addCommonLabels({ event_type: eventType }), duration),
  
  // Heartbeat
  heartbeatReceived: () => heartbeatReceived.inc(addCommonLabels()),
  heartbeatTimeout: () => heartbeatTimeout.inc(addCommonLabels()),
  staleCallsDetected: () => staleCallsDetected.inc(addCommonLabels()),
  
  // Connection
  activeConnections: (count) => activeConnections.set(addCommonLabels(), count),
  websocketReconnect: () => websocketReconnect.inc(addCommonLabels()),
  
  // Redis
  redisOperations: (operation, duration) => redisOperations.observe(addCommonLabels({ operation }), duration),
  redisErrors: (operation, errorType) => redisErrors.inc(addCommonLabels({ operation, error_type: errorType })),
  redisCircuitBreakerState: (state) => redisCircuitBreakerState.set(addCommonLabels(), state),
  
  // Existing
  signalingLatency: (duration) => signalingLatency.observe(addCommonLabels(), duration),
  callFailures: (reason) => callFailures.inc(addCommonLabels({ reason })),
  packetLoss: (loss) => packetLoss.observe(addCommonLabels(), loss),
  jitter: (jitterMs) => jitter.observe(addCommonLabels(), jitterMs),
  rtt: (rttMs) => rtt.observe(addCommonLabels(), rttMs),
  sfuFallbacks: () => sfuFallbacks.inc(addCommonLabels()),
  modeSwitches: (direction) => modeSwitches.inc(addCommonLabels({ direction })),
  authAttempts: (action, result) => authAttempts.inc(addCommonLabels({ action, result })),
  
  // Raw metrics for advanced usage
  raw: {
    callStateTransitions,
    callDuration,
    activeCalls,
    ghostConnections,
    criticalEventsSent,
    criticalEventsAcked,
    criticalEventsRetry,
    messageDeliveryLatency,
    heartbeatReceived,
    heartbeatTimeout,
    staleCallsDetected,
    activeConnections,
    websocketReconnect,
    redisOperations,
    redisErrors,
    redisCircuitBreakerState,
    signalingLatency,
    callFailures,
    packetLoss,
    jitter,
    rtt,
    sfuFallbacks,
    modeSwitches,
    authAttempts,
  },
};

module.exports = metrics;
