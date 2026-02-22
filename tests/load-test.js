// ─── k6 Load Test: WebSocket Signaling ───────────────────────────────────────
// Simulates 1000+ concurrent WebSocket connections
// Run: k6 run --vus 100 --duration 5m tests/load-test.js
// ──────────────────────────────────────────────────────────────────────────────
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const wsConnectDuration = new Trend("ws_connect_duration");
const wsMessageRate = new Rate("ws_message_success");

export const options = {
  stages: [
    { duration: "30s", target: 100 }, // Ramp up to 100 users
    { duration: "2m", target: 500 }, // Ramp to 500
    { duration: "2m", target: 1000 }, // Peak at 1000
    { duration: "30s", target: 0 }, // Ramp down
  ],
  thresholds: {
    ws_connect_duration: ["p(95)<2000"], // 95% connect under 2s
    ws_message_success: ["rate>0.95"], // 95% message success
  },
};

const WS_URL = __ENV.WS_URL || "ws://localhost:3000/ws";
const TOKEN = __ENV.TEST_TOKEN || "test-jwt-token";

export default function () {
  const startTime = Date.now();

  const res = ws.connect(`${WS_URL}?token=${TOKEN}`, {}, function (socket) {
    wsConnectDuration.add(Date.now() - startTime);

    socket.on("open", () => {
      // Simulate heartbeat
      socket.setInterval(() => {
        socket.send(JSON.stringify({ type: "heartbeat" }));
      }, 25000);

      // Simulate call request
      socket.send(
        JSON.stringify({
          type: "call-request",
          targetUserId: "load-test-target",
        }),
      );
    });

    socket.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);
        wsMessageRate.add(data.type !== undefined);
      } catch {
        wsMessageRate.add(false);
      }
    });

    socket.on("error", () => {
      wsMessageRate.add(false);
    });

    // Keep connection alive for test duration
    sleep(30);

    socket.close();
  });

  check(res, { "Connected successfully": (r) => r && r.status === 101 });
}
