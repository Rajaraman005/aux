/**
 * UploadContext — React bridge for UploadQueue.
 *
 * Provides reactive upload state to UI components.
 * Uses .on()/.off() cleanup pattern for eventemitter3.
 * isMountedRef guard prevents state updates after unmount.
 */

import React, { createContext, useContext, useRef, useState, useEffect, useCallback } from "react";
import UploadQueue from "../services/uploadQueue";
import * as mediaService from "../services/mediaService";

const UploadContext = createContext(null);

export function UploadProvider({ children }) {
  const queueRef = useRef(null);
  const [uploads, setUploads] = useState(new Map());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    const queue = new UploadQueue({
      uploadFn: mediaService.uploadFile,
    });
    queueRef.current = queue;

    const handleProgress = (id, progress) => {
      if (!isMountedRef.current) return;
      setUploads((prev) => {
        const next = new Map(prev);
        const item = next.get(id);
        if (item) {
          next.set(id, { ...item, progress, status: item.status === "pending" ? "uploading" : item.status });
        }
        return next;
      });
    };

    const handleComplete = (id, result) => {
      if (!isMountedRef.current) return;
      setUploads((prev) => {
        const next = new Map(prev);
        next.set(id, { status: "complete", progress: 1, result });
        return next;
      });
    };

    const handleError = (id, error) => {
      if (!isMountedRef.current) return;
      setUploads((prev) => {
        const next = new Map(prev);
        next.set(id, { status: "failed", error: error.message });
        return next;
      });
    };

    queue.on("uploadProgress", handleProgress);
    queue.on("uploadComplete", handleComplete);
    queue.on("uploadError", handleError);

    return () => {
      isMountedRef.current = false;
      queue.off("uploadProgress", handleProgress);
      queue.off("uploadComplete", handleComplete);
      queue.off("uploadError", handleError);
      queue.destroy();
    };
  }, []);

  const enqueue = useCallback((params) => {
    const id = queueRef.current?.enqueue(params);
    if (id) {
      setUploads((prev) => new Map(prev).set(id, { status: "pending", progress: 0 }));
    }
    return id;
  }, []);

  const cancel = useCallback((id) => {
    queueRef.current?.cancel(id);
    setUploads((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const retry = useCallback((id) => {
    queueRef.current?.retry(id);
    setUploads((prev) => {
      const next = new Map(prev);
      const item = next.get(id);
      if (item) {
        next.set(id, { ...item, status: "pending", progress: 0, error: null });
      }
      return next;
    });
  }, []);

  const getStatus = useCallback((id) => {
    return queueRef.current?.getStatus(id);
  }, []);

  const isAnyUploading = Array.from(uploads.values()).some(
    (u) => u.status !== "complete" && u.status !== "failed",
  );

  return (
    <UploadContext.Provider value={{ uploads, enqueue, cancel, retry, getStatus, isAnyUploading }}>
      {children}
    </UploadContext.Provider>
  );
}

export function useUploadQueue() {
  const ctx = useContext(UploadContext);
  if (!ctx) {
    throw new Error("useUploadQueue must be used within UploadProvider");
  }
  return ctx;
}