/**
 * Storage adapters for persisting verifier state.
 *
 * These adapters work in both browsers and Node.js environments.
 *
 * @packageDocumentation
 */

import type { StorageAdapter, VerifierState } from './types.js';

/**
 * In-memory storage adapter.
 * Useful for testing or when persistence is not needed.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly storage = new Map<string, VerifierState>();

  async save(key: string, state: VerifierState): Promise<void> {
    this.storage.set(key, state);
  }

  async load(key: string): Promise<VerifierState | null> {
    return this.storage.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.storage.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.storage.has(key);
  }

  /**
   * Clear all stored states.
   */
  clear(): void {
    this.storage.clear();
  }
}

/**
 * localStorage adapter for browser environments.
 * Falls back gracefully if localStorage is not available.
 */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly prefix: string;

  /**
   * Create a new localStorage adapter.
   *
   * @param prefix - Key prefix for namespacing (default: 'bao-verifier:')
   */
  constructor(prefix = 'bao-verifier:') {
    this.prefix = prefix;
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private getStorage(): Storage | null {
    try {
      // Check if localStorage is available and working
      if (typeof localStorage !== 'undefined') {
        const testKey = `${this.prefix}__test__`;
        localStorage.setItem(testKey, 'test');
        localStorage.removeItem(testKey);
        return localStorage;
      }
    } catch {
      // localStorage not available or blocked
    }
    return null;
  }

  async save(key: string, state: VerifierState): Promise<void> {
    const storage = this.getStorage();
    if (!storage) {
      console.warn('localStorage not available, state will not be persisted');
      return;
    }

    try {
      const serialized = JSON.stringify(state);
      storage.setItem(this.getKey(key), serialized);
    } catch (error) {
      // Handle quota exceeded or other errors
      if (error instanceof Error && error.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old states');
        this.clearOldStates(storage);
        // Retry once
        try {
          storage.setItem(this.getKey(key), JSON.stringify(state));
        } catch {
          console.error('Failed to save state after clearing old states');
        }
      }
    }
  }

  async load(key: string): Promise<VerifierState | null> {
    const storage = this.getStorage();
    if (!storage) {
      return null;
    }

    try {
      const data = storage.getItem(this.getKey(key));
      if (!data) {
        return null;
      }
      return JSON.parse(data) as VerifierState;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const storage = this.getStorage();
    if (storage) {
      storage.removeItem(this.getKey(key));
    }
  }

  async exists(key: string): Promise<boolean> {
    const storage = this.getStorage();
    if (!storage) {
      return false;
    }
    return storage.getItem(this.getKey(key)) !== null;
  }

  /**
   * Clear old states to free up space.
   */
  private clearOldStates(storage: Storage): void {
    const keysToRemove: string[] = [];

    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(this.prefix)) {
        keysToRemove.push(key);
      }
    }

    // Remove oldest states first (based on savedAt)
    const states = keysToRemove
      .map((key) => {
        try {
          const data = storage.getItem(key);
          if (data) {
            const state = JSON.parse(data) as VerifierState;
            return { key, savedAt: state.savedAt };
          }
        } catch {
          // Invalid state, mark for removal
        }
        return { key, savedAt: '' };
      })
      .sort((a, b) => a.savedAt.localeCompare(b.savedAt));

    // Remove oldest half
    const removeCount = Math.ceil(states.length / 2);
    for (let i = 0; i < removeCount; i++) {
      const state = states[i];
      if (state) {
        storage.removeItem(state.key);
      }
    }
  }
}

/**
 * IndexedDB adapter for browser environments.
 * Provides larger storage capacity than localStorage.
 */
export class IndexedDBStorageAdapter implements StorageAdapter {
  private readonly dbName: string;
  private readonly storeName = 'verifier-states';
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Create a new IndexedDB adapter.
   *
   * @param dbName - Database name (default: 'bao-verifier')
   */
  constructor(dbName = 'bao-verifier') {
    this.dbName = dbName;
  }

  private async getDB(): Promise<IDBDatabase | null> {
    if (this.db) {
      return this.db;
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    // Check if IndexedDB is available
    if (typeof indexedDB === 'undefined') {
      return null;
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const request = indexedDB.open(this.dbName, 1);

        request.onerror = () => {
          reject(new Error('Failed to open IndexedDB'));
        };

        request.onsuccess = () => {
          this.db = request.result;
          resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'key' });
          }
        };
      } catch (error) {
        reject(error);
      }
    });

    try {
      return await this.dbPromise;
    } catch {
      this.dbPromise = null;
      return null;
    }
  }

  async save(key: string, state: VerifierState): Promise<void> {
    const db = await this.getDB();
    if (!db) {
      console.warn('IndexedDB not available, state will not be persisted');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.put({ key, state });

        request.onerror = () => reject(new Error('Failed to save state'));
        request.onsuccess = () => resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  async load(key: string): Promise<VerifierState | null> {
    const db = await this.getDB();
    if (!db) {
      return null;
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction([this.storeName], 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.get(key);

        request.onerror = () => reject(new Error('Failed to load state'));
        request.onsuccess = () => {
          const result = request.result as { key: string; state: VerifierState } | undefined;
          resolve(result?.state ?? null);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDB();
    if (!db) {
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(key);

        request.onerror = () => reject(new Error('Failed to delete state'));
        request.onsuccess = () => resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  async exists(key: string): Promise<boolean> {
    const state = await this.load(key);
    return state !== null;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = null;
    }
  }

  /**
   * Delete the entire database.
   */
  async deleteDatabase(): Promise<void> {
    this.close();

    if (typeof indexedDB === 'undefined') {
      return;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      request.onerror = () => reject(new Error('Failed to delete database'));
      request.onsuccess = () => resolve();
    });
  }
}

/**
 * Create the best available storage adapter for the current environment.
 *
 * Prefers IndexedDB over localStorage for larger capacity.
 */
export function createStorageAdapter(): StorageAdapter {
  // Try IndexedDB first (larger capacity)
  if (typeof indexedDB !== 'undefined') {
    return new IndexedDBStorageAdapter();
  }

  // Fall back to localStorage
  if (typeof localStorage !== 'undefined') {
    return new LocalStorageAdapter();
  }

  // Fall back to in-memory storage
  return new MemoryStorageAdapter();
}
