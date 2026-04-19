/**
 * UploadQueue — Pure state machine for upload management.
 *
 * Uses eventemitter3 (RN-compatible, not Node's EventEmitter).
 * Receives uploadFn via constructor injection — no circular dependency.
 * AppState listener for foreground resume.
 * Persists failed uploads via uploadRepository for offline retry.
 */

import EventEmitter from "eventemitter3";
import { v4 as uuidv4 } from "./uuid";
import { AppState } from "react-native";
import analytics from "./analytics";
import uploadRepository from "./uploadRepository";

const MAX_CONCURRENT = 3;
const MAX_QUEUE = 10;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;

class UploadQueue extends EventEmitter {
  constructor({ uploadFn }) {
    super();
    this._uploadFn = uploadFn;
    this.queue = new Map();
    this.activeControllers = new Map();
    this._processing = false;
    this._appStateSub = null;
    this._setupAppStateListener();
    this._restorePendingUploads();
  }

  enqueue(params) {
    if (this.queue.size >= MAX_QUEUE) {
      throw new Error("Upload queue full");
    }

    const id = uuidv4();
    const record = {
      id,
      ...params,
      status: "pending",
      progress: 0,
      error: null,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.queue.set(id, record);
    analytics.emit("upload_offline_queued", { uploadId: id });
    this.emit("enqueued", id);
    this._processQueue();
    return id;
  }

  cancel(uploadId) {
    const controller = this.activeControllers.get(uploadId);
    if (controller) {
      controller.abort();
    }
    const record = this.queue.get(uploadId);
    if (record) {
      record.status = "cancelled";
      this.queue.delete(uploadId);
      uploadRepository.remove(uploadId);
      analytics.emit("upload_cancelled", { uploadId });
      this.emit("uploadCancelled", uploadId);
    }
  }

  retry(uploadId) {
    const record = this.queue.get(uploadId);
    if (record && record.status === "failed" && record.retryCount < MAX_RETRIES) {
      record.status = "pending";
      record.error = null;
      record.retryCount++;
      record.updatedAt = new Date().toISOString();
      analytics.emit("upload_retried", { uploadId, attempt: record.retryCount });
      this.emit("uploadRetrying", uploadId, record.retryCount);
      this._processQueue();
    }
  }

  getStatus(uploadId) {
    return this.queue.get(uploadId) || null;
  }

  getAll() {
    return Array.from(this.queue.values());
  }

  destroy() {
    this.activeControllers.forEach((controller) => controller.abort());
    this.activeControllers.clear();
    if (this._appStateSub) {
      this._appStateSub.remove();
    }
    this.removeAllListeners();
  }

  _setupAppStateListener() {
    this._appStateSub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        this._restorePendingUploads();
      }
    });
  }

  async _restorePendingUploads() {
    try {
      const records = await uploadRepository.load();
      for (const record of records) {
        if (
          (record.status === "failed" && record.retryCount < MAX_RETRIES) ||
          record.status === "pending"
        ) {
          if (record.status === "failed") record.status = "pending";
          this.queue.set(record.id, record);
          analytics.emit("upload_offline_resumed", { uploadId: record.id });
        }
      }
      this._processQueue();
    } catch (err) {
      console.error("Restore pending uploads error:", err);
    }
  }

  _processQueue() {
    if (this._processing) return;

    const activeCount = Array.from(this.queue.values()).filter(
      (r) =>
        r.status !== "complete" &&
        r.status !== "failed" &&
        r.status !== "cancelled",
    ).length;

    if (activeCount >= MAX_CONCURRENT) return;

    const pending = Array.from(this.queue.values()).find(
      (r) => r.status === "pending",
    );
    if (pending) {
      this._startUpload(pending.id);
    }
  }

  async _startUpload(uploadId) {
    const record = this.queue.get(uploadId);
    if (!record) return;

    record.status = "compressing";
    record.updatedAt = new Date().toISOString();
    this.emit("uploadStarted", uploadId);

    const controller = new AbortController();
    this.activeControllers.set(uploadId, controller);

    try {
      const result = await this._uploadFn(
        {
          uri: record.uri,
          mediaType: record.mediaType,
          fileSize: record.fileSize,
          mimeType: record.mimeType,
          width: record.width,
          height: record.height,
          duration: record.duration,
          uploadId: record.id,
        },
        {
          onProgress: (progress) => {
            record.progress = progress;
            record.updatedAt = new Date().toISOString();
            this.emit("uploadProgress", uploadId, progress);
          },
          signal: controller.signal,
        },
      );

      record.status = "complete";
      record.progress = 1;
      record.updatedAt = new Date().toISOString();
      this.emit("uploadComplete", uploadId, result);

      setTimeout(() => {
        uploadRepository.remove(uploadId);
        this.queue.delete(uploadId);
      }, 60000);
    } catch (error) {
      record.status = "failed";
      record.error = error.message;
      record.updatedAt = new Date().toISOString();

      if (error.retryable && record.retryCount < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, record.retryCount);
        setTimeout(() => this.retry(uploadId), delay);
      } else {
        uploadRepository.update(uploadId, record);
      }

      this.emit("uploadError", uploadId, error);
    } finally {
      this.activeControllers.delete(uploadId);
      setTimeout(() => this._processQueue(), 0);
    }
  }
}

export default UploadQueue;