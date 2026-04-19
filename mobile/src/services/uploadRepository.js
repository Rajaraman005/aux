/**
 * UploadRepository — AsyncStorage persistence layer.
 *
 * Single Responsibility: handles ONLY read/write.
 * No business logic. No state management.
 *
 * Only 'pending' and 'failed' records are persisted.
 * 'complete' records are removed after save.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@aux_upload_queue";
const MAX_RECORDS = 20;

class UploadRepository {
  async load() {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  async save(records) {
    try {
      const persistable = records
        .filter((r) => r.status === "pending" || r.status === "failed")
        .slice(0, MAX_RECORDS);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch (err) {
      console.error("UploadRepository save error:", err);
    }
  }

  async add(record) {
    const records = await this.load();
    records.push(record);
    await this.save(records);
  }

  async remove(id) {
    const records = await this.load();
    const filtered = records.filter((r) => r.id !== id);
    await this.save(filtered);
  }

  async update(id, partial) {
    const records = await this.load();
    const index = records.findIndex((r) => r.id === id);
    if (index !== -1) {
      records[index] = { ...records[index], ...partial, updatedAt: new Date().toISOString() };
      await this.save(records);
    }
  }

  async get(id) {
    const records = await this.load();
    return records.find((r) => r.id === id) || null;
  }

  async clear() {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error("UploadRepository clear error:", err);
    }
  }
}

export default new UploadRepository();