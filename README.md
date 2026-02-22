# 📞 VideoCall — FAANG-Grade Low-Bandwidth Video Calling App

**Audio-first. Crystal-clear voice on 2G networks. World-class UI.**

## 🏗 Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        React Native Mobile App                        │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────────┐   │
│  │ Auth Flow │  │ WebRTC Engine│  │ Network  │  │ Audio Engine   │   │
│  │ Login     │  │ Opus 24kbps  │  │ Monitor  │  │ VAD, Levels    │   │
│  │ Signup    │  │ SDP Munging  │  │ 5-Tier   │  │ Enhancement    │   │
│  │ Verify    │  │ ICE Restart  │  │ Adaptive │  │ Waveform       │   │
│  └──────────┘  └──────────────┘  └──────────┘  └────────────────┘   │
└─────────────────────────────┬──────────────────────────────────────────┘
                              │ WebSocket + HTTPS
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster (GKE Autopilot)                  │
│  ┌─────────────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ Signaling Pods (HPA)│◄─►  Redis HA    │  │ coturn TURN      │    │
│  │ 2-10 replicas       │  │  Pub/Sub     │  │ DaemonSet        │    │
│  │ Anti-affinity       │  │  Presence    │  │ Host networking   │    │
│  └─────────────────────┘  └──────────────┘  └──────────────────────┘ │
│  ┌─────────────────────┐  ┌──────────────────────────────────────┐   │
│  │ Prometheus + Grafana│  │ Supabase (PostgreSQL + Auth)          │   │
│  │ Alerting rules      │  │ Connection pooling, migrations       │   │
│  └─────────────────────┘  └──────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

## 🔥 Audio Engineering (The Core)

| Feature    | Implementation                                 |
| ---------- | ---------------------------------------------- |
| Codec      | Opus, forced at 8-24kbps via SDP munging       |
| FEC        | Forward Error Correction enabled               |
| DTX        | Discontinuous Transmission for silence savings |
| Priority   | Audio = HIGH, Video = LOW network priority     |
| Adaptation | 5-tier quality system with EMA smoothing       |
| Fallback   | Video drops → Audio-only → Never drops audio   |
| Recovery   | ICE restart for WiFi ↔ LTE handoff             |

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Supabase account (free tier works)
- Expo CLI (`npm install -g expo-cli`)

### 1. Server Setup

```bash
cd server
cp .env.example .env
# Fill in your Supabase URL/key and JWT secrets
npm install
npm start
```

### 2. Mobile Setup

```bash
cd mobile
npm install
npx expo start
```

### 3. Full Stack (Docker)

```bash
docker-compose up -d
# Signaling: http://localhost:3000
# Grafana:   http://localhost:3001
# Prometheus: http://localhost:9090
```

## 📁 Project Structure

```
videocall/
├── server/                   # Node.js backend
│   ├── src/
│   │   ├── config.js         # Environment config
│   │   ├── index.js          # Express + WebSocket entry
│   │   ├── db/supabase.js    # Supabase client + migrations
│   │   ├── middleware/       # Auth, rate limiting
│   │   ├── routes/           # Auth, user endpoints
│   │   ├── services/         # Email, avatar, metrics
│   │   └── signaling/        # WebSocket handler, Redis, presence
│   └── Dockerfile
├── mobile/                   # React Native (Expo)
│   ├── App.js                # Root navigator
│   └── src/
│       ├── config/api.js     # API endpoints
│       ├── context/          # AuthContext
│       ├── screens/          # Login, Signup, Verify, Home, Call
│       ├── services/         # API, Socket, WebRTC, Network, Audio
│       └── styles/theme.js   # Design system
├── infra/                    # Infrastructure
│   ├── k8s/manifests.yml     # Kubernetes (HPA, DaemonSet)
│   ├── terraform/main.tf     # GKE + Redis + TURN (multi-region)
│   ├── prometheus.yml        # Metrics collection
│   ├── alert_rules.yml       # Alerting
│   └── turnserver.conf       # coturn config
├── tests/
│   ├── load-test.js          # k6 (1000 concurrent WS)
│   └── network-sim.sh        # 2G/3G/packet loss simulation
└── docker-compose.yml        # Full stack orchestration
```

## ⚡ Performance Targets

| Metric            | Target       | How                                            |
| ----------------- | ------------ | ---------------------------------------------- |
| Call setup        | < 2s         | ICE candidate pooling, pre-gathered candidates |
| Audio latency     | < 150ms      | Opus low-delay mode, mono, small packets       |
| Voice at 15% loss | Intelligible | FEC + packet loss concealment                  |
| Bandwidth floor   | 50kbps       | Audio-only mode, Opus 8kbps                    |

## 🧪 Testing

```bash
# Load test (k6)
k6 run --vus 100 --duration 5m tests/load-test.js

# Network simulation (Linux)
sudo bash tests/network-sim.sh eth0 30
```

## 📊 Observability

- **Prometheus** scrapes signaling server every 5s
- **Grafana** dashboards for packet loss, jitter, RTT, call failures
- **Alerting**: auto-fires on >15% packet loss, >100ms jitter, >10% call failure rate

## 📄 License

MIT
