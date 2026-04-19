/**
 * compressionService.test.js — Test Contracts
 *
 * These define what "done" looks like for the compression service.
 * Mock expo-image-manipulator and expo-file-system for unit testing.
 *
 * Run: cd mobile && npm test -- --testPathPattern=compressionService
 */

// Mock expo-image-manipulator
jest.mock("expo-image-manipulator", () => ({
  manipulateAsync: jest.fn(),
  SaveFormat: { JPEG: "jpeg" },
}));

// Mock expo-file-system/legacy (used by compressionService)
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(),
}));

// Mock @react-native-community/netinfo
jest.mock("@react-native-community/netinfo", () => ({
  fetch: jest.fn(),
}));

// Mock analytics
jest.mock("../analytics", () => ({
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
}));

describe("compressForUpload", () => {
  let ImageManipulator;
  let FileSystem;
  let NetInfo;
  let compressForUpload, compressImage, getNetworkQuality, validateVideoConstraints, estimateFileSize;

  beforeEach(() => {
    jest.clearAllMocks();
    ImageManipulator = require("expo-image-manipulator");
    FileSystem = require("expo-file-system/legacy");
    NetInfo = require("@react-native-community/netinfo");
    const mod = require("../compressionService");
    compressForUpload = mod.compressForUpload;
    compressImage = mod.compressImage;
    getNetworkQuality = mod.getNetworkQuality;
    validateVideoConstraints = mod.validateVideoConstraints;
    estimateFileSize = mod.estimateFileSize;
  });

  it("compresses a large image to fit within maxDimension", async () => {
    ImageManipulator.manipulateAsync.mockResolvedValue({
      uri: "compressed://test",
      width: 1440,
      height: 1080,
    });
    FileSystem.getInfoAsync.mockResolvedValue({ size: 500000, exists: true });

    const result = await compressImage("file://test.jpg", {
      quality: 0.8,
      maxDimension: 1920,
      originalSize: 3000000,
    });

    expect(result.width).toBeLessThanOrEqual(1920);
    expect(result.height).toBeLessThanOrEqual(1920);
    expect(result.fileSize).toBe(500000);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.uri).toBe("compressed://test");
  });

  it("returns original URI for audio (no compression)", async () => {
    FileSystem.getInfoAsync.mockResolvedValue({ size: 1024, exists: true });

    const result = await compressForUpload("file://audio.m4a", "audio", {
      mimeType: "audio/m4a",
      duration: 30,
    });

    expect(result.uri).toBe("file://audio.m4a");
    expect(result.mimeType).toBe("audio/m4a");
    expect(result.fileSize).toBe(1024);
  });

  it("getNetworkQuality returns slow for low downlink", async () => {
    NetInfo.fetch.mockResolvedValue({ details: { downlink: 0.3 } });
    const { getNetworkQuality } = require("../compressionService");
    const quality = await getNetworkQuality();
    expect(quality).toBe("slow");
  });

  it("getNetworkQuality returns fast for high downlink", async () => {
    jest.resetModules();
    jest.mock("@react-native-community/netinfo", () => ({ fetch: jest.fn().mockResolvedValue({ details: { downlink: 5 } }) }));
    const { getNetworkQuality } = require("../compressionService");
    const quality = await getNetworkQuality();
    expect(quality).toBe("fast");
  });

  it("getNetworkQuality returns normal on NetInfo error", async () => {
    jest.resetModules();
    jest.mock("@react-native-community/netinfo", () => ({ fetch: jest.fn().mockRejectedValue(new Error("fail")) }));
    const { getNetworkQuality } = require("../compressionService");
    const quality = await getNetworkQuality();
    expect(quality).toBe("normal");
  });

  it("validateVideoConstraints rejects oversized videos", () => {
    const result = validateVideoConstraints(120 * 1024 * 1024, 60);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("too large");
  });

  it("validateVideoConstraints accepts videos within limits", () => {
    const result = validateVideoConstraints(10 * 1024 * 1024, 30);
    expect(result.valid).toBe(true);
  });

  it("rejects files exceeding the size limit for images", async () => {
    FileSystem.getInfoAsync.mockResolvedValue({ size: 15 * 1024 * 1024, exists: true });

    await expect(compressForUpload("file:///large.jpg", "image", {}))
      .rejects.toThrow("File too large");
  });

  it("rejects files exceeding the size limit for video", async () => {
    FileSystem.getInfoAsync.mockResolvedValue({ size: 150 * 1024 * 1024, exists: true });

    await expect(compressForUpload("file:///huge.mp4", "video", {}))
      .rejects.toThrow("File too large");
  });

  it("allows files within the size limit", async () => {
    ImageManipulator.manipulateAsync.mockResolvedValue({
      uri: "compressed://test",
      width: 1920,
      height: 1080,
    });
    FileSystem.getInfoAsync.mockResolvedValue({ size: 5 * 1024 * 1024, exists: true });
    NetInfo.fetch.mockResolvedValue({ details: { downlink: 5 } });

    const result = await compressForUpload("file:///photo.jpg", "image", {});
    expect(result).toBeDefined();
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("logs warning and proceeds when file size is 0", async () => {
    FileSystem.getInfoAsync.mockResolvedValue({ size: 0, exists: true });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    ImageManipulator.manipulateAsync.mockResolvedValue({
      uri: "compressed://test",
      width: 1920,
      height: 1080,
    });
    NetInfo.fetch.mockResolvedValue({ details: { downlink: 5 } });

    const result = await compressForUpload("content://media/photo.jpg", "image", {});
    expect(warnSpy).toHaveBeenCalledWith(
      "[compressionService] Could not determine file size for URI:",
      "content://media/photo.jpg"
    );
    warnSpy.mockRestore();
  });

  it("estimateFileSize returns file size from FileSystem", async () => {
    FileSystem.getInfoAsync.mockResolvedValue({ size: 2048, exists: true });
    const size = await estimateFileSize("file://test.jpg");
    expect(size).toBe(2048);
  });

  it("estimateFileSize returns 0 on error", async () => {
    FileSystem.getInfoAsync.mockRejectedValue(new Error("not found"));
    const size = await estimateFileSize("file://test.jpg");
    expect(size).toBe(0);
  });
});