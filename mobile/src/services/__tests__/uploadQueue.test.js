/**
 * uploadQueue.test.js — Test Contracts
 *
 * State machine transitions for the upload queue.
 *
 * Run: cd mobile && npm test -- --testPathPattern=uploadQueue
 */

// Mock dependencies
jest.mock("eventemitter3", () => {
  const { EventEmitter } = require("events");
  return EventEmitter;
});
jest.mock("../analytics", () => ({
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
}));
jest.mock("../uploadRepository", () => ({
  load: jest.fn().mockResolvedValue([]),
  save: jest.fn().mockResolvedValue(undefined),
  add: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  clear: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("react-native", () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

const mockUploadFn = jest.fn();

describe("UploadQueue state machine", () => {
  let UploadQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    // Need to re-require to get fresh instance
    jest.resetModules();
    UploadQueue = require("../uploadQueue").default;
  });

  it("transitions from pending to complete on successful upload", async () => {
    mockUploadFn.mockResolvedValue({ url: "https://cdn.example.com/test.jpg" });

    const queue = new UploadQueue({ uploadFn: mockUploadFn });

    const id = queue.enqueue({
      uri: "file://test.jpg",
      mediaType: "image",
      fileSize: 100000,
      mimeType: "image/jpeg",
    });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    const status = queue.getStatus(id);
    expect(status).toBeTruthy();
    expect(status.status).toBe("complete");

    queue.destroy();
  });

  it("transitions to failed on upload error", async () => {
    const error = new Error("Network error");
    error.retryable = false;
    mockUploadFn.mockRejectedValue(error);

    const queue = new UploadQueue({ uploadFn: mockUploadFn });

    const id = queue.enqueue({
      uri: "file://test.jpg",
      mediaType: "image",
      fileSize: 100000,
      mimeType: "image/jpeg",
    });

    await new Promise((r) => setTimeout(r, 100));

    const status = queue.getStatus(id);
    expect(status).toBeTruthy();
    expect(status.status).toBe("failed");

    queue.destroy();
  });

  it("does not exceed MAX_QUEUE size", () => {
    const queue = new UploadQueue({ uploadFn: mockUploadFn });

    // Fill queue to max
    for (let i = 0; i < 10; i++) {
      queue.enqueue({
        uri: `file://test${i}.jpg`,
        mediaType: "image",
        fileSize: 100000,
        mimeType: "image/jpeg",
      });
    }

    // Next enqueue should throw
    expect(() => {
      queue.enqueue({
        uri: "file://overflow.jpg",
        mediaType: "image",
        fileSize: 100000,
        mimeType: "image/jpeg",
      });
    }).toThrow("Upload queue full");

    queue.destroy();
  });

  it("cancel sets status to cancelled and removes from queue", () => {
    mockUploadFn.mockImplementation(() => new Promise(() => {})); // never resolves

    const queue = new UploadQueue({ uploadFn: mockUploadFn });

    const id = queue.enqueue({
      uri: "file://test.jpg",
      mediaType: "image",
      fileSize: 100000,
      mimeType: "image/jpeg",
    });

    queue.cancel(id);

    const status = queue.getStatus(id);
    expect(status).toBeNull(); // removed from queue

    queue.destroy();
  });

  it("retry moves failed back to pending", async () => {
    const error = new Error("Network error");
    error.retryable = false;
    mockUploadFn.mockRejectedValue(error);

    const queue = new UploadQueue({ uploadFn: mockUploadFn });

    const id = queue.enqueue({
      uri: "file://test.jpg",
      mediaType: "image",
      fileSize: 100000,
      mimeType: "image/jpeg",
    });

    await new Promise((r) => setTimeout(r, 100));

    // Should be failed
    expect(queue.getStatus(id).status).toBe("failed");

    // Retry — status transitions to "pending" then immediately starts processing
    queue.retry(id);
    const status = queue.getStatus(id).status;
    expect(["pending", "compressing"]).toContain(status);

    queue.destroy();
  });

  it("getAll returns all queue items", () => {
    mockUploadFn.mockImplementation(() => new Promise(() => {}));

    const queue = new UploadQueue({ uploadFn: mockUploadFn });

    queue.enqueue({ uri: "file://a.jpg", mediaType: "image", fileSize: 100, mimeType: "image/jpeg" });
    queue.enqueue({ uri: "file://b.jpg", mediaType: "image", fileSize: 100, mimeType: "image/jpeg" });

    const all = queue.getAll();
    expect(all.length).toBe(2);

    queue.destroy();
  });

  });