# Fix Random World Video Chat — L5/L6 Design Doc

## Invariant Violations (Root Causes)

### Bug 1: Matchmaking Contract Violation
**Invariant:** `joinQueue(userId)` must return a match result **only if `userId` is a participant**, or `null` if they are queued.

**Violation:** `joinQueue(C)` pushes C into `[A, B, C]`, then `tryMatch()` pops A and B, returns `{A, B}` to C's handler. `handleWorldJoin(C)` calls `_notifyMatchedUsers({A, B})` — correct for A and B, but C receives no response. C is still in the queue but `handleWorldJoin` already returned without sending a "searching" status.

**Concrete fix — pseudocode:**
```js
// matchmaking.js — joinQueue(userId)
async joinQueue(userId) {
  // ... existing validation and queue push ...
  await redis.rpush("world:queue", userId);
  
  // NEW: Loop tryMatch until either:
  //   (a) a match involving THIS user is found, or
  //   (b) no more matches are possible
  let matchResult = null;
  let safetyCounter = 0;
  while (safetyCounter++ < 10) {
    const result = await this.tryMatch();
    if (!result) break; // Queue exhausted
    
    if (result.user1 === userId || result.user2 === userId) {
      matchResult = result; // This user is matched
      break;
    }
    
    // Match found but doesn't involve us — notify those users, keep looping
    await this._notifyMatchedUsers(result);
  }
  return matchResult; // null = still queued, object = matched
}
```

**Same fix for `_joinQueueMemory`:**
```js
_joinQueueMemory(userId) {
  // ... push userId ...
  while (this._inMemoryQueue.length >= 2) {
    const result = this._tryMatchMemoryOnce(); // Extract single-match logic
    if (!result) break;
    if (result.user1 === userId || result.user2 === userId) return result;
    this._notifyMatchedUsers(result); // Notify others, keep trying
  }
  return null; // Queued, waiting
}
```

**Failure modes of this fix:**
- **Infinite loop:** Bounded by `safetyCounter = 10`. Worst case: 10 Redis Lua calls (~5ms each = 50ms). Acceptable.
- **Stale queue entries:** If the queue has >10 stale users ahead of us, we'll stop and return null. User stays queued. On their next match attempt (tryMatchWithRetries background tick), they'll be matched. No data loss.
- **Concurrent joinQueue calls:** Both may try `tryMatch()` simultaneously. But the Lua script is atomic — only one will succeed per pair. The loser gets `null` and stays queued. Correct.

---

### Bug 2: Ghost Video — Stream Lifecycle Contract Violation
**Invariant:** When a peer disconnects or a session ends, `onRemoteStream(null)` **must** be called before or during cleanup to ensure React state reflects the disconnection.

**Violation:** `cleanup()` sets `this.remoteStream = null` (line 890) but **never invokes** `this.onRemoteStream?.(null)`. The React component still holds a stale `MediaStream` reference → `RTCView` renders the last decoded frame.

**Secondary violation:** `pc.ontrack` (line 236) never registers `track.onended` or `track.onmute` listeners. When the remote peer stops their camera track, no callback fires.

**Concrete fix — webrtc.js cleanup():**
```js
// BEFORE nulling references, notify React
if (this.remoteStream) {
  this.onRemoteStream?.(null);  // ← THE FIX: React sets remoteStream = null
  this.remoteStream = null;
}
if (this.localStream) {
  this.localStream.getTracks().forEach(track => track.stop());
  this.onLocalStream?.(null);   // ← Same for local
  this.localStream = null;
}
```

**Concrete fix — webrtc.js pc.ontrack:**
```js
this.pc.ontrack = (event) => {
  if (event.streams && event.streams[0]) {
    this.remoteStream = event.streams[0];
    this.onRemoteStream?.(this.remoteStream);
    
    // NEW: Track-level lifecycle listeners
    const track = event.track;
    
    track.onended = () => {
      console.log(`[TRACK_ENDED] kind=${track.kind}`);
      if (track.kind === 'video') {
        this.onRemoteCameraState?.(false);
      }
      // If ALL tracks ended, clear stream
      const activeTracks = this.remoteStream?.getTracks().filter(t => t.readyState === 'live');
      if (!activeTracks || activeTracks.length === 0) {
        this.onRemoteStream?.(null);
        this.remoteStream = null;
      }
    };
    
    track.onmute = () => {
      console.log(`[TRACK_MUTED] kind=${track.kind}`);
      if (track.kind === 'video') {
        this.onRemoteCameraState?.(false);
      }
    };
    
    track.onunmute = () => {
      console.log(`[TRACK_UNMUTED] kind=${track.kind}`);
      if (track.kind === 'video') {
        this.onRemoteCameraState?.(true);
      }
    };
  }
};
```

**Failure modes:**
- **`onRemoteStream(null)` called twice** (once from track.onended, once from cleanup): Safe — React `setRemoteStream(null)` is idempotent. useMatchmaking already handles null.
- **`track.onended` fires after cleanup:** The `this.remoteStream?.getTracks()` call will return empty/undefined. Guard handles it.
- **`onmute` without corresponding `onunmute`:** This is normal when peer disconnects. The cleanup path handles it.

---

### Bug 3: WebRTC Singleton Lifecycle Contract

**Invariant:** The WebRTC engine is a singleton. At any given time, exactly one owner (1:1 call OR world video) controls its callbacks. A new `initialize()` call must **not** have its callbacks wiped by a stale `cleanup()` from the previous owner.

**Violation:** `initWebRTC()` in useMatchmaking sets callbacks (lines 291-368), then calls `webrtcEngine.initialize()`. But `initialize()` internally may trigger no cleanup (it doesn't call cleanup). However, `cleanup()` in useMatchmaking calls `webrtcEngine.cleanup()` which resets `onOffer = null`, `onAnswer = null`, `onIceCandidate = null` (lines 924-926). 

The real race: `nextMatch()` calls `cleanup()` (which wipes callbacks), then `joinQueue()` fires, match comes back, `initWebRTC()` sets callbacks, then calls `initialize()`. Between `initialze()` starting (async TURN fetch, media access) and it finishing, if old timers or events fire `cleanup()` again, callbacks are wiped.

**Concrete fix — generation-based ownership:**
```js
// useMatchmaking.js
const sessionGenerationRef = useRef(0);

const initWebRTC = useCallback(async (isCaller, currentSessionId) => {
  const myGeneration = ++sessionGenerationRef.current;
  
  // Set callbacks FIRST
  webrtcEngine.onCallStateChange = (newState) => {
    if (sessionGenerationRef.current !== myGeneration) return; // Stale callback
    // ... handle state change ...
  };
  // ... other callbacks with same guard ...
  
  await webrtcEngine.initialize(currentSessionId, isCaller, true);
  
  // After initialize, verify we're still the active generation
  if (sessionGenerationRef.current !== myGeneration) {
    console.log('[STALE_SESSION] Generation mismatch after initialize, aborting');
    webrtcEngine.cleanup();
    return;
  }
  
  if (isCaller) {
    await webrtcEngine.createOffer();
  }
}, []);
```

**Failure modes:**
- **Generation counter overflow:** JavaScript numbers are 64-bit floats, safe up to 2^53. At 1 match/second, that's ~285 million years. Not a concern.
- **Callback fires during generation increment:** The increment is synchronous and on the JS event loop. Callbacks are also dispatched on the event loop. No interleaving possible.

---

### Bug 4: ICE Timeout — Missing State Machine Guard

**Invariant:** Every non-terminal state must have a timeout that transitions to either a recovery state or a terminal state.

**Violation:** `ICE_CHECKING_TIMEOUT_MS = 20000` is declared but never used. If ICE gathering/checking stalls, the user is stuck on "Connecting..." forever.

**Concrete fix:**
```js
// In initWebRTC, after webrtcEngine initialization:
webrtcEngine.onIceConnectionStateChange = (iceState) => {
  if (sessionGenerationRef.current !== myGeneration) return;
  
  if (iceState === 'checking') {
    transition(STATES.ICE_CHECKING);
    // ARM the timeout
    setTimer('iceChecking', () => {
      if (stateRef.current === STATES.ICE_CHECKING || stateRef.current === STATES.ICE_GATHERING) {
        console.log('[ICE_TIMEOUT] ICE did not complete within 20s');
        nextMatch();
      }
    }, ICE_CHECKING_TIMEOUT_MS);
  } else if (iceState === 'connected' || iceState === 'completed') {
    // DISARM the timeout — ICE succeeded
    clearTimeout(timersRef.current['iceChecking']);
    transition(STATES.CONNECTED); // Will be handled by onCallStateChange too
  }
};
```

**Edge case analysis — ICE succeeds at 19.9s:**
- `onIceConnectionStateChange('connected')` fires at 19.9s → clears `iceChecking` timer → timer never fires. Correct.
- `onIceConnectionStateChange('connected')` fires at 20.0s (simultaneously with timer): Timer fires first (was scheduled earlier), calls `nextMatch()`. Then `connected` callback fires but generation has changed → guarded by `sessionGenerationRef.current !== myGeneration`. **No double-state.** The connection that just succeeded will be cleaned up by the new `nextMatch()` which calls `cleanup()`. **Slight UX glitch** (user sees brief "connected" then "searching") but no data corruption. This is acceptable — a 20-second ICE is already a bad connection.
- **Mitigation:** Set timeout to 15s instead of 20s to increase safety margin. Or: check `webrtcEngine.pc?.iceConnectionState` inside the timer before acting.

**Concrete timer guard (belt and suspenders):**
```js
setTimer('iceChecking', () => {
  const currentIceState = webrtcEngine.pc?.iceConnectionState;
  if (currentIceState === 'connected' || currentIceState === 'completed') {
    console.log('[ICE_TIMEOUT_CANCELLED] ICE already connected');
    return; // Don't kill a working connection
  }
  if (stateRef.current === STATES.ICE_CHECKING || stateRef.current === STATES.ICE_GATHERING) {
    console.log('[ICE_TIMEOUT] ICE did not complete within 20s, skipping');
    nextMatch();
  }
}, ICE_CHECKING_TIMEOUT_MS);
```

---

### Bug 5: Camera State Not Signaled to Peer

**Invariant:** Any local media state change must be communicated to the remote peer via signaling so the remote UI can reflect it.

**Violation:** `toggleCamera()` calls `videoTrack.enabled = false` but sends no signaling message. The remote peer's `RTCView` shows black frames (which look like a frozen image on some devices) with no "Camera Off" indicator.

**Concrete fix — 3 layers:**

**Layer 1 — Signaling (socket.js):**
```js
sendWorldVideoCameraState(sessionId, cameraOn) {
  return this.send({ type: 'world-video-camera-state', sessionId, cameraOn });
}
```

**Layer 2 — Backend relay (handler.js):**
```js
case 'world-video-camera-state':
  await handleWorldVideoCameraState(userId, message);
  break;

async function handleWorldVideoCameraState(userId, message) {
  const { sessionId, cameraOn } = message;
  if (!sessionId) return;
  const session = await matchmaking.getSession(sessionId);
  if (!session) return;
  const userState = await matchmaking.getUserSession(userId);
  if (!userState || userState.sessionId !== sessionId) return;
  const peerId = session.user1 === userId ? session.user2 : session.user1;
  await presence.sendToUser(peerId, {
    type: 'world-video-camera-state',
    sessionId,
    cameraOn,
  });
}
```

**Layer 3 — Frontend (useMatchmaking.js + RandomVideoScreen.js):**
```js
// useMatchmaking.js — new state
const [remoteCameraOff, setRemoteCameraOff] = useState(false);

// Listen for signaling
push(signalingClient.on('world-video-camera-state', (msg) => {
  if (msg.sessionId !== sessionIdRef.current) return;
  setRemoteCameraOff(!msg.cameraOn);
}));

// Listen for WebRTC track events
webrtcEngine.onRemoteCameraState = (cameraOn) => {
  setRemoteCameraOff(!cameraOn);
};

// toggleCamera — send signaling
const toggleCamera = useCallback(() => {
  const isOff = webrtcEngine.toggleCamera();
  if (sessionIdRef.current) {
    signalingClient.sendWorldVideoCameraState(sessionIdRef.current, !isOff);
  }
  return isOff;
}, []);
```

---

## WebRTC Singleton Lifecycle Contract (Explicit)

The `webrtcEngine` singleton has exactly **3 states**:

```
IDLE ──initialize()──→ ACTIVE ──cleanup()──→ ENDING ──→ IDLE
```

**Rules:**
1. `initialize()` may only be called from `IDLE` state. If called from `ACTIVE`, the caller must first `cleanup()`.
2. `cleanup()` is idempotent — calling it from `IDLE` is a no-op.
3. Callbacks (`onRemoteStream`, `onOffer`, etc.) are set by the **owner** (useMatchmaking or CallManager). They are cleared in `cleanup()`.
4. **No callback may be invoked after `cleanup()` completes.** The generation-based guard in useMatchmaking ensures this.
5. `cleanup()` MUST call `onRemoteStream(null)` and `onLocalStream(null)` before clearing references.

**Enforcement:** The `_isCleaningUp` guard already prevents re-entrant cleanup. We add the generation-based guard on the consumer side to prevent stale callback invocations.

---

## In-Memory Fallback Policy

**Decision:** The in-memory matchmaking path (`_tryMatchMemory`, `_joinQueueMemory`) exists for **local development only**.

**Guarantees:**
- Single-process only. No cross-pod routing.
- Same FIFO ordering as Redis path.
- Same blocklist semantics.
- **NOT safe for production** — no persistence, no atomic guarantees across restarts.

**Enforcement:** Add a startup log warning if Redis is unavailable:
```js
if (!redisBridge.isConnected) {
  console.warn('⚠️  PRODUCTION WARNING: Redis unavailable. Matchmaking is in-memory mode. ' +
    'DO NOT use in production — no persistence, no cross-pod support.');
}
```

---

## Observability Plan

### Structured Logging (every log prefixed with event type for grep/structured parsing)

| Event | Log Format | When |
|-------|-----------|------|
| `[MATCH_FOUND]` | `sessionId, user1, user2, latencyMs` | Lua script returns match |
| `[MATCH_QUEUED]` | `userId, queuePosition` | User queued, no match |
| `[MATCH_RETRY]` | `userId, attempt, reason` | Match involved other users |
| `[SESSION_END]` | `sessionId, reason, durationS` | Any session termination |
| `[OFFER_SENT]` | `sessionId, role, sdpLength` | WebRTC offer created |
| `[ANSWER_SENT]` | `sessionId, role, sdpLength` | WebRTC answer created |
| `[ICE_CANDIDATE_SENT]` | `sessionId, candidateType` | ICE candidate trickled |
| `[ICE_STATE]` | `sessionId, state` | ICE connection state change |
| `[ICE_TIMEOUT]` | `sessionId, elapsedMs` | ICE checking exceeded timeout |
| `[PEER_DISCONNECTED]` | `sessionId, reason` | Peer WebSocket closed |
| `[GHOST_VIDEO_PREVENTED]` | `sessionId` | onRemoteStream(null) called in cleanup |
| `[TRACK_ENDED]` | `sessionId, trackKind` | Remote track ended event |
| `[TRACK_MUTED]` | `sessionId, trackKind` | Remote track muted event |
| `[CAMERA_STATE]` | `sessionId, cameraOn, direction` | Camera toggled (local/remote) |
| `[STALE_CALLBACK]` | `sessionId, generation, currentGen` | Generation mismatch prevented stale action |
| `[CLEANUP]` | `sessionId, prevState, callbacksCleared` | Cleanup executed |

### Server-Side Metrics (Prometheus-compatible, using existing `metrics.js`)

```js
// Add to metrics.js
matchQueueSize: new Gauge({ name: 'world_match_queue_size', help: 'Current queue length' }),
matchLatency: new Histogram({ name: 'world_match_latency_ms', help: 'Time from join to match' }),
matchRetries: new Counter({ name: 'world_match_retries_total', help: 'Match retry attempts', labelNames: ['reason'] }),
sessionEndReasons: new Counter({ name: 'world_session_end_total', help: 'Session end reasons', labelNames: ['reason'] }),
iceTimeouts: new Counter({ name: 'world_ice_timeout_total', help: 'ICE timeout count' }),
ghostVideoPrevented: new Counter({ name: 'world_ghost_video_prevented_total', help: 'Ghost video prevention events' }),
```

### Client-Side Crash Logging

All new events will use existing `crashLogger.log(CATEGORIES.WEBRTC_ERROR, ...)` with the structured event names above.

---

## Proposed Changes (File-by-File)

### Backend

#### [MODIFY] [matchmaking.js](file:///c:/Users/Sugan001/Desktop/videocall/server/src/services/matchmaking.js)
- Rewrite `joinQueue()` with match-loop (return only if userId is participant)
- Rewrite `_joinQueueMemory()` with same loop
- Extract `_tryMatchMemoryOnce()` from `_tryMatchMemory()`
- Add structured logging for all match/queue events
- Add startup Redis warning

#### [MODIFY] [handler.js](file:///c:/Users/Sugan001/Desktop/videocall/server/src/signaling/handler.js)
- Fix `handleWorldJoin` to handle match-not-involving-user case
- Add `world-video-camera-state` message handler + relay
- Add structured logging

---

### Frontend

#### [MODIFY] [webrtc.js](file:///c:/Users/Sugan001/Desktop/videocall/mobile/src/services/webrtc.js)
- `cleanup()`: call `onRemoteStream(null)` and `onLocalStream(null)` before nulling
- `pc.ontrack`: add `track.onended`, `track.onmute`, `track.onunmute` listeners
- Add `onRemoteCameraState` callback field
- Add structured console logging with event tags

#### [MODIFY] [useMatchmaking.js](file:///c:/Users/Sugan001/Desktop/videocall/mobile/src/hooks/useMatchmaking.js)
- Add `sessionGenerationRef` for stale callback prevention
- Add ICE checking timeout (with iceConnectionState guard)
- Add `remoteCameraOff` state + signaling listener
- Add `onRemoteCameraState` callback wiring
- Fix `toggleCamera` to send camera state signaling
- Add structured logging

#### [MODIFY] [RandomVideoScreen.js](file:///c:/Users/Sugan001/Desktop/videocall/mobile/src/screens/RandomVideoScreen.js)
- Add "Camera Off" overlay on remote video when `remoteCameraOff` is true
- Show avatar/placeholder when `remoteStream` is null during connected state
- Consume `remoteCameraOff` from useMatchmaking

#### [MODIFY] [socket.js](file:///c:/Users/Sugan001/Desktop/videocall/mobile/src/services/socket.js)
- Add `sendWorldVideoCameraState(sessionId, cameraOn)` helper
