#!/bin/bash
# ─── Network Simulation Tests ────────────────────────────────────────────────
# Simulates degraded network conditions to test audio resilience.
# Requires: Linux with tc (traffic control) and netem
# Run as root: sudo bash tests/network-sim.sh
# ──────────────────────────────────────────────────────────────────────────────

set -e

INTERFACE=${1:-eth0}
DURATION=${2:-30}

echo "🌐 Network Simulation Tests"
echo "   Interface: $INTERFACE"
echo "   Duration per test: ${DURATION}s"
echo "   Make a test call during each scenario!"
echo ""

# Clean up any existing rules
cleanup() {
  echo "🧹 Cleaning up network rules..."
  tc qdisc del dev $INTERFACE root 2>/dev/null || true
}

trap cleanup EXIT

# ─── Test 1: 2G Network (300ms latency, 20% packet loss) ─────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 Test 1: 2G Network Simulation"
echo "   Latency: 300ms | Packet Loss: 20% | Bandwidth: 50kbps"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
tc qdisc add dev $INTERFACE root netem delay 300ms 50ms loss 20% rate 50kbit
echo "⏳ Running for ${DURATION}s... Make a call now!"
sleep $DURATION
cleanup
echo "✅ Test 1 complete"
echo ""

sleep 5

# ─── Test 2: 3G Network (150ms latency, 5% packet loss) ──────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 Test 2: 3G Network Simulation"
echo "   Latency: 150ms | Packet Loss: 5% | Bandwidth: 200kbps"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
tc qdisc add dev $INTERFACE root netem delay 150ms 30ms loss 5% rate 200kbit
echo "⏳ Running for ${DURATION}s... Make a call now!"
sleep $DURATION
cleanup
echo "✅ Test 2 complete"
echo ""

sleep 5

# ─── Test 3: Extreme Packet Loss (15%) ────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 Test 3: Extreme Packet Loss"
echo "   Latency: 100ms | Packet Loss: 15% | Bandwidth: 100kbps"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
tc qdisc add dev $INTERFACE root netem delay 100ms 20ms loss 15% rate 100kbit
echo "⏳ Running for ${DURATION}s... Make a call now!"
sleep $DURATION
cleanup
echo "✅ Test 3 complete"
echo ""

sleep 5

# ─── Test 4: WiFi → LTE Handoff (sudden disconnect + reconnect) ──────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 Test 4: WiFi ↔ LTE Handoff Simulation"
echo "   Drops connection for 3s, then reconnects with higher latency"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⏳ Normal connection for 10s..."
sleep 10
echo "❌ Simulating network drop (100% loss for 3s)..."
tc qdisc add dev $INTERFACE root netem loss 100%
sleep 3
cleanup
echo "🔄 Reconnecting with LTE-like conditions..."
tc qdisc add dev $INTERFACE root netem delay 80ms 20ms loss 2% rate 500kbit
echo "⏳ Running for ${DURATION}s..."
sleep $DURATION
cleanup
echo "✅ Test 4 complete"
echo ""

# ─── Test 5: Jitter Storm ────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 Test 5: High Jitter"
echo "   Latency: 50ms ± 150ms (extreme jitter)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
tc qdisc add dev $INTERFACE root netem delay 50ms 150ms distribution pareto
echo "⏳ Running for ${DURATION}s... Make a call now!"
sleep $DURATION
cleanup
echo "✅ Test 5 complete"
echo ""

echo "🏁 All network simulation tests complete!"
echo "   Check call quality metrics at http://localhost:3001 (Grafana)"
