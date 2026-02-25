/**
 * Unit Tests — WebRTC Cleanup & Socket Reconnect Logic
 *
 * Tests the pure state-machine and lifecycle logic without the full RN runtime.
 * Run: npx jest tests/stability.test.js
 */

// ─── Mock Setup ─────────────────────────────────────────────────────────────
// Minimal mocks for modules that import React Native internals

jest.mock("react-native", () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    currentState: "active",
  },
  Platform: { OS: "android" },
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  multiRemove: jest.fn(() => Promise.resolve()),
}));

jest.mock("react-native-webrtc", () => ({
  mediaDevices: { getUserMedia: jest.fn() },
  RTCPeerConnection: jest.fn(),
  RTCSessionDescription: jest.fn(),
  RTCIceCandidate: jest.fn(),
  MediaStream: jest.fn(),
}));

jest.mock("react-native-incall-manager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  setKeepScreenOn: jest.fn(),
  setSpeakerphoneOn: jest.fn(),
}));

jest.mock("expo-av", () => ({
  Audio: {
    setAudioModeAsync: jest.fn(),
    Sound: { createAsync: jest.fn() },
  },
}));

// Stub signaling, API, and config modules
jest.mock(
  "../mobile/src/services/socket",
  () => ({
    on: jest.fn(() => jest.fn()),
    send: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    requestCall: jest.fn(),
    hangUp: jest.fn(),
    sendIceCandidate: jest.fn(),
    sendCallMetrics: jest.fn(),
    isConnected: false,
  }),
  { virtual: true },
);

jest.mock(
  "../mobile/src/config/api",
  () => ({
    WS_BASE: "ws://localhost:3000/ws",
    API_BASE: "http://localhost:3000",
    endpoints: {
      turn: "http://localhost:3000/api/turn-credentials",
      auth: { refresh: "http://localhost:3000/api/auth/refresh" },
    },
  }),
  { virtual: true },
);

jest.mock(
  "../mobile/src/services/api",
  () => ({
    get: jest.fn(() => Promise.resolve({ iceServers: [] })),
    accessToken: "test-token",
    getDeviceId: jest.fn(),
    getItem: jest.fn(),
    setItem: jest.fn(),
  }),
  { virtual: true },
);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("CrashLogger", () => {
  let CrashLogger;
  let AsyncStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.isolateModules(() => {
      AsyncStorage = require("@react-native-async-storage/async-storage");
      CrashLogger = require("../mobile/src/services/CrashLogger").default;
    });
  });

  test("log() should not throw even if AsyncStorage fails", () => {
    AsyncStorage.setItem.mockRejectedValue(new Error("Storage full"));
    expect(() => {
      CrashLogger.log("CRASH_DETECTED", "test crash", new Error("boom"));
    }).not.toThrow();
  });

  test("log() should queue entries and flush asynchronously", async () => {
    AsyncStorage.getItem.mockResolvedValue(null);
    AsyncStorage.setItem.mockResolvedValue(undefined);

    CrashLogger.log("APP_START", "test message");
    expect(CrashLogger._queue.length).toBe(1);

    await CrashLogger.flushNow();
    expect(AsyncStorage.setItem).toHaveBeenCalled();
  });

  test("circular buffer should limit to MAX_ENTRIES", async () => {
    // Pre-fill with 250 entries
    const existing = Array.from({ length: 250 }, (_, i) => ({
      t: new Date().toISOString(),
      c: "TEST",
      m: `entry ${i}`,
    }));
    AsyncStorage.getItem.mockResolvedValue(JSON.stringify(existing));
    AsyncStorage.setItem.mockResolvedValue(undefined);

    CrashLogger.log("APP_START", "new entry");
    await CrashLogger.flushNow();

    const lastCall = AsyncStorage.setItem.mock.calls[0];
    const stored = JSON.parse(lastCall[1]);
    expect(stored.length).toBeLessThanOrEqual(200);
  });

  test("logMemoryUsage should not throw if Hermes is not available", () => {
    expect(() => CrashLogger.logMemoryUsage()).not.toThrow();
  });
});

describe("WebRTC Cleanup Race Condition", () => {
  let webrtcEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.isolateModules(() => {
      webrtcEngine = require("../mobile/src/services/webrtc").default;
    });
  });

  test("cleanup() should be idempotent — multiple calls should not crash", () => {
    // Set engine to a non-IDLE state to allow cleanup
    webrtcEngine._callState = "connecting";
    webrtcEngine._isCleaningUp = false;

    expect(() => {
      webrtcEngine.cleanup();
      webrtcEngine.cleanup(); // Second call should be no-op
      webrtcEngine.cleanup(); // Third call should be no-op
    }).not.toThrow();
  });

  test("cleanup() should prevent re-entry via _isCleaningUp flag", () => {
    webrtcEngine._callState = "connected";
    webrtcEngine._isCleaningUp = true;

    // Should return immediately without doing anything
    const stateBefore = webrtcEngine._callState;
    webrtcEngine.cleanup();
    expect(webrtcEngine._callState).toBe(stateBefore);
  });

  test("cleanup() should not crash when pc is null", () => {
    webrtcEngine._callState = "connected";
    webrtcEngine.pc = null;
    webrtcEngine.localStream = null;
    webrtcEngine._isCleaningUp = false;

    expect(() => webrtcEngine.cleanup()).not.toThrow();
    expect(webrtcEngine._callState).toBe("idle");
  });

  test("cleanup() resets all state correctly", () => {
    webrtcEngine._callState = "connected";
    webrtcEngine.callId = "test-call-id";
    webrtcEngine._iceRestartAttempts = 2;
    webrtcEngine._initialized = true;
    webrtcEngine._isCleaningUp = false;

    webrtcEngine.cleanup();

    expect(webrtcEngine._callState).toBe("idle");
    expect(webrtcEngine.callId).toBeNull();
    expect(webrtcEngine._iceRestartAttempts).toBe(0);
    expect(webrtcEngine._initialized).toBe(false);
    expect(webrtcEngine._isCleaningUp).toBe(false);
  });
});

describe("Socket Reconnect Logic", () => {
  test("_onForegroundResume should attempt reconnect when socket is dead", () => {
    jest.isolateModules(() => {
      const signalingClient = require("../mobile/src/services/socket").default;

      // Simulate socket that died while backgrounded
      signalingClient.ws = { readyState: 3 }; // WebSocket.CLOSED = 3
      signalingClient.token = "test-token";
      signalingClient._isBackgrounded = false;

      // The connect method should be called
      const connectSpy = jest.fn();
      signalingClient.connect = connectSpy;

      signalingClient._onForegroundResume();

      expect(connectSpy).toHaveBeenCalledWith("test-token");
    });
  });

  test("_onForegroundResume should resume heartbeat when socket is open", () => {
    jest.isolateModules(() => {
      const signalingClient = require("../mobile/src/services/socket").default;

      // Simulate still-open socket
      signalingClient.ws = { readyState: 1, send: jest.fn() }; // WebSocket.OPEN = 1
      signalingClient.isConnected = true;
      signalingClient._isBackgrounded = false;

      const startHeartbeatSpy = jest.fn();
      signalingClient.startHeartbeat = startHeartbeatSpy;

      signalingClient._onForegroundResume();

      expect(startHeartbeatSpy).toHaveBeenCalled();
    });
  });

  test("_pauseHeartbeat should clear all timers", () => {
    jest.isolateModules(() => {
      const signalingClient = require("../mobile/src/services/socket").default;

      signalingClient.heartbeatTimer = setInterval(() => {}, 1000);
      signalingClient._pongCheckTimer = setInterval(() => {}, 1000);

      signalingClient._pauseHeartbeat();

      expect(signalingClient.heartbeatTimer).toBeNull();
      expect(signalingClient._pongCheckTimer).toBeNull();
    });
  });
});

describe("AudioEngine Timer Leak", () => {
  let audioEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.isolateModules(() => {
      audioEngine = require("../mobile/src/services/audioEngine").default;
    });
  });

  test("startMonitoring called twice should not leak intervals", () => {
    const clearSpy = jest.spyOn(global, "clearInterval");
    const mockStream = {
      getAudioTracks: () => [{ enabled: true }],
    };

    audioEngine.startMonitoring(mockStream);
    const firstInterval = audioEngine.monitorInterval;

    audioEngine.startMonitoring(mockStream);

    // First interval should have been cleared
    expect(clearSpy).toHaveBeenCalledWith(firstInterval);
    // New interval should exist
    expect(audioEngine.monitorInterval).not.toBe(firstInterval);

    audioEngine.stop();
    clearSpy.mockRestore();
  });

  test("stop() should cleanup all state", () => {
    const mockStream = {
      getAudioTracks: () => [{ enabled: true }],
    };

    audioEngine.startMonitoring(mockStream);
    expect(audioEngine.isActive).toBe(true);
    expect(audioEngine.monitorInterval).not.toBeNull();

    audioEngine.stop();

    expect(audioEngine.isActive).toBe(false);
    expect(audioEngine.monitorInterval).toBeNull();
    expect(audioEngine.audioLevel).toBe(0);
    expect(audioEngine.isSpeaking).toBe(false);
  });
});
