/**
 * worldVideoLeave.test.js
 *
 * Contract tests for World Video session end semantics in no-Redis mode.
 * Focus: world-leave must end the session for both peers and include per-user {requeue}.
 */

jest.mock("../../signaling/redis", () => ({ isConnected: false }));

const mockPresence = { sendToUser: jest.fn(() => Promise.resolve()) };
jest.mock("../../signaling/presence", () => mockPresence);

const mockDb = { createWorldVideoSession: jest.fn(() => Promise.resolve()) };
jest.mock("../../db/supabase", () => ({ db: mockDb }));

describe("World Video: leave/next/timeout requeue directive", () => {
  let matchmaking;

  beforeEach(() => {
    jest.resetModules();
    mockPresence.sendToUser.mockClear();
    mockDb.createWorldVideoSession.mockClear();
    matchmaking = require("../matchmaking");

    // Reset in-memory state on the singleton
    matchmaking._inMemoryQueue = [];
    matchmaking._inMemoryUsers = new Map();
    matchmaking._inMemorySessions = new Map();
    matchmaking._inMemoryTokenMap = new Map();
    matchmaking._sessionTimers = new Map();
  });

  function seedSession(sessionId, user1, user2) {
    matchmaking._inMemorySessions.set(sessionId, {
      user1,
      user2,
      token1: "t1",
      token2: "t2",
      startedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
      status: "active",
    });

    matchmaking._inMemoryUsers.set(user1, {
      status: "matched",
      sessionId,
      matchedWith: user2,
      role: "caller",
      ephemeralToken: "t1",
      peerToken: "t2",
    });

    matchmaking._inMemoryUsers.set(user2, {
      status: "matched",
      sessionId,
      matchedWith: user1,
      role: "callee",
      ephemeralToken: "t2",
      peerToken: "t1",
    });
  }

  test("leave: endedBy user does not requeue; peer requeues", async () => {
    const sessionId = "s1";
    const userA = "userA";
    const userB = "userB";
    seedSession(sessionId, userA, userB);

    await matchmaking.leaveWorldVideo(userA, { sessionIdHint: sessionId });

    expect(mockPresence.sendToUser).toHaveBeenCalledWith(
      userA,
      expect.objectContaining({
        type: "world-session-end",
        sessionId,
        reason: "leave",
        endedBy: userA,
        requeue: false,
      }),
    );

    expect(mockPresence.sendToUser).toHaveBeenCalledWith(
      userB,
      expect.objectContaining({
        type: "world-session-end",
        sessionId,
        reason: "leave",
        endedBy: userA,
        requeue: true,
      }),
    );
  });

  test("next: both peers requeue", async () => {
    const sessionId = "s2";
    const userA = "userA";
    const userB = "userB";
    seedSession(sessionId, userA, userB);

    await matchmaking.endSession(sessionId, "next", userA);

    expect(mockPresence.sendToUser).toHaveBeenCalledWith(
      userA,
      expect.objectContaining({ reason: "next", requeue: true }),
    );
    expect(mockPresence.sendToUser).toHaveBeenCalledWith(
      userB,
      expect.objectContaining({ reason: "next", requeue: true }),
    );
  });

  test("timeout: both peers requeue", async () => {
    const sessionId = "s3";
    const userA = "userA";
    const userB = "userB";
    seedSession(sessionId, userA, userB);

    await matchmaking.endSession(sessionId, "timeout");

    expect(mockPresence.sendToUser).toHaveBeenCalledWith(
      userA,
      expect.objectContaining({ reason: "timeout", requeue: true }),
    );
    expect(mockPresence.sendToUser).toHaveBeenCalledWith(
      userB,
      expect.objectContaining({ reason: "timeout", requeue: true }),
    );
  });
});
