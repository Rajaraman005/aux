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

const app = express();
const server = http.createServer(app);

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

// ─── Health Check ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    connections: presence.getLocalConnectionCount(),
    redis: redisBridge.isConnected,
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
      metrics.packetLoss.observe(stats.packetLoss);
    if (stats.jitter !== undefined) metrics.jitter.observe(stats.jitter);
    if (stats.rtt !== undefined) metrics.rtt.observe(stats.rtt);
  }
  res.json({ received: true });
});

// ─── TURN Credentials (time-limited HMAC) ────────────────────────────────────
app.get("/api/turn-credentials", (req, res) => {
  const crypto = require("crypto");
  const ttl = config.turn.ttl;
  const username = `${Math.floor(Date.now() / 1000) + ttl}:videocall`;
  const hmac = crypto.createHmac("sha1", config.turn.secret);
  hmac.update(username);
  const credential = hmac.digest("base64");

  res.json({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      {
        urls: config.turn.url,
        username,
        credential,
      },
    ],
    ttl,
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
    console.log(`${"═".repeat(50)}\n`);
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
