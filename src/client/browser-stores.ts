// ---------------------------------------------------------------------------
// Browser key-value stores — KeyValueStore implementations backed by the
// browser's localStorage and IndexedDB. The browser globals are referenced
// only inside methods so these modules stay importable under Node (they throw
// only if actually used there).
// ---------------------------------------------------------------------------

import type { KeyValueStore } from './auth.js'

/**
 * KeyValueStore backed by `localStorage`. Synchronous and simple; suitable for
 * OAuth tokens and client registration state in single-page apps. Keys are
 * namespaced by a prefix to avoid collisions with other app state.
 */
export class LocalStorageStore implements KeyValueStore {
  private readonly _prefix: string

  constructor(prefix = 'fastmcp:') {
    this._prefix = prefix
  }

  async get(key: string): Promise<string | null> {
    return localStorage.getItem(this._prefix + key)
  }

  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(this._prefix + key, value)
  }

  async delete(key: string): Promise<void> {
    localStorage.removeItem(this._prefix + key)
  }
}

/**
 * KeyValueStore backed by IndexedDB. Preferred when tokens should survive
 * outside the synchronous, size-limited localStorage (e.g. larger payloads or
 * stricter persistence). Opens the database per operation and closes it again.
 */
export class IndexedDBStore implements KeyValueStore {
  private readonly _dbName: string
  private readonly _storeName: string

  constructor(opts: { dbName?: string; storeName?: string } = {}) {
    this._dbName = opts.dbName ?? 'fastmcp'
    this._storeName = opts.storeName ?? 'auth'
  }

  private _open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(this._storeName)) {
          req.result.createObjectStore(this._storeName)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
    })
  }

  private async _tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this._open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(this._storeName, mode).objectStore(this._storeName))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'))
      })
    } finally {
      db.close()
    }
  }

  async get(key: string): Promise<string | null> {
    const value = await this._tx<string | undefined>('readonly', (s) => s.get(key))
    return value ?? null
  }

  async set(key: string, value: string): Promise<void> {
    await this._tx('readwrite', (s) => s.put(value, key))
  }

  async delete(key: string): Promise<void> {
    await this._tx('readwrite', (s) => s.delete(key))
  }
}
