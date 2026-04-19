/**
 * Server Entry Point.
 * Express HTTP + WebSocket signaling + Prometheus metrics.
 * Production-grade: Helmet, CORS, graceful shutdown, health checks.
 */
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const helmet = require("helmet");
const cors = require("cors");
const config = require("./config");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const { initializeSignaling } = require("./signaling/handler");
const redisBridge = require("./signaling/redis");
const presence = require("./signaling/presence");
const metrics = require("./services/metrics");
const heartbeatWatchdog = require("./services/heartbeatWatchdog");
const { pushMetrics } = require("./services/pushService");
const fcmService = require("./services/fcmService");
const matchmaking = require("./services/matchmaking");

const app = express();
const server = http.createServer(app);

// ─── Trust Proxy (required for Render/Railway/Heroku behind reverse proxy) ──
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// and cannot correctly identify clients by IP.
app.set("trust proxy", 1);

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable for API server
    crossOriginEmbedderPolicy: false,
  }),
);

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: config.isDev ? "*" : process.env.ALLOWED_ORIGINS?.split(","),
    credentials: true,
  }),
);

// ─── Body Parsing ────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Request Logging (dev) ───────────────────────────────────────────────────
if (config.isDev) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      if (!req.path.includes("/metrics") && !req.path.includes("/health")) {
        console.log(
          `${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`,
        );
      }
    });
    next();
  });
}

// ─── API Routes ──────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/conversations", require("./routes/chat"));
app.use("/api/world", require("./routes/world"));
app.use("/api/world-video", require("./routes/worldVideo"));
app.use("/api/push", require("./routes/pushRoutes"));
app.use("/api/friends", require("./routes/friends"));
app.use("/api/notifications", require("./routes/notifications"));
app.use(
  "/api/notifications/preferences",
  require("./routes/notificationPrefsRoutes"),
);
app.use("/api/media", require("./routes/mediaRoutes"));
app.use("/api/calls", require("./routes/calls"));

// ─── Health Check ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    connections: presence.getLocalConnectionCount(),
    redis: redisBridge.isConnected,
    push: pushMetrics.getStats(),
    fcm: fcmService.diagnose(), // ★ Full FCM diagnostic state
    timestamp: new Date().toISOString(),
  });
});

// ─── Prometheus Metrics Endpoint ─────────────────────────────────────────────
app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", metrics.register.contentType);
    res.end(await metrics.register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ─── Call Metrics Ingestion (from mobile clients) ────────────────────────────
app.post("/api/metrics/call", express.json(), (req, res) => {
  const { callId, stats } = req.body;
  if (stats) {
    if (stats.packetLoss !== undefined)
      metrics.packetLoss(stats.packetLoss);
    if (stats.jitter !== undefined) metrics.jitter(stats.jitter);
    if (stats.rtt !== undefined) metrics.rtt(stats.rtt);
  }
  res.json({ received: true });
});

// ─── ICE Server Credentials (Metered.ca TURN) ───────────────────────────────
app.get("/api/turn-credentials", (req, res) => {
  res.json({
    iceServers: [
      { urls: "stun:stun.relay.metered.ca:80" },
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "40e7863b297fb9c3ad752855",
        credential: "/ZKqRLSXQu2ynNyF",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "40e7863b297fb9c3ad752855",
        credential: "/ZKqRLSXQu2ynNyF",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "40e7863b297fb9c3ad752855",
        credential: "/ZKqRLSXQu2ynNyF",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "40e7863b297fb9c3ad752855",
        credential: "/ZKqRLSXQu2ynNyF",
      },
    ],
    ttl: 86400,
  });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
});

// ─── Error Handler ───────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res
    .status(500)
    .json({ error: "Internal server error", code: "SERVER_ERROR" });
});

// ─── WebSocket Server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });
initializeSignaling(wss);

// ─── Startup ─────────────────────────────────────────────────────────────────
async function start() {
  // Connect Redis (non-blocking — falls back to in-memory)
  await redisBridge.connect();

  // Initialize matchmaking service (loads Lua script, subscribes to keyspace)
  await matchmaking.init();

  // Initialize heartbeat watchdog (distributed stale call detection)
  heartbeatWatchdog.initialize();

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        `\n❌ Port ${config.port} is already in use.\n` +
          `   - Stop the other process using it, or\n` +
          `   - Start with a different port: set PORT=3001 (Windows: $env:PORT=3001)\n`,
      );
      process.exit(1);
    }
    console.error("\n❌ Server error:", err);
    process.exit(1);
  });

  server.listen(config.port, () => {
    console.log(`\n${"═".repeat(50)}`);
    console.log(`🚀 Aux Server v1.0.0`);
    console.log(`   Environment: ${config.env}`);
    console.log(`   HTTP:        http://localhost:${config.port}`);
    console.log(`   WebSocket:   ws://localhost:${config.port}/ws`);
    console.log(`   Health:      http://localhost:${config.port}/health`);
    console.log(`   Metrics:     http://localhost:${config.port}/metrics`);
    console.log(
      `   Redis:       ${redisBridge.isConnected ? "✅ Connected" : "⚠️  In-Memory Fallback"}`,
    );
    console.log(
      `   FCM:         ${fcmService.isConfigured() ? "✅ Configured" : "⚠️  Not Configured"}`,
    );

    // ★ TURN server production warning
    if (!config.isDev && config.turn.url.includes("localhost")) {
      console.warn(
        `\n⚠️  WARNING: TURN_SERVER_URL points to localhost in production!`,
      );
      console.warn(`   Calls will fail behind symmetric NATs (~30% of users).`);
      console.warn(
        `   Set TURN_SERVER_URL to a real coturn/Twilio/Xirsys TURN server.\n`,
      );
    }

    console.log(`${"═".repeat(50)}\n`);

    // ─── Daily Notification Cleanup (90-day expiration) ────────────────
    const { db: notifDb } = require("./db/supabase");
    setInterval(
      () => {
        notifDb
          .cleanupExpiredNotifications(90)
          .catch((err) =>
            console.error("Notification cleanup error:", err.message),
          );
      },
      24 * 60 * 60 * 1000,
    );
    // Run once on startup
    notifDb.cleanupExpiredNotifications(90).catch(() => {});
  });
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n🛑 ${signal} received — shutting down gracefully...`);

  // Close WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1001, "Server shutting down");
  });

  // Close HTTP server
  server.close();

  // Disconnect Redis
  await redisBridge.disconnect();

  // Shutdown heartbeat watchdog
  heartbeatWatchdog.shutdown();

  console.log("👋 Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Unhandled Error Safety Net ──────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
});

start();
