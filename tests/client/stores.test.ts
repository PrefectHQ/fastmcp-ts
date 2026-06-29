// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { LocalStorageStore, IndexedDBStore } from 'fastmcp-ts/client'

// Node 22.4+ expose a native experimental `localStorage` global that is unusable
// unless `--localstorage-file` is provided. Under vitest's jsdom environment it
// shadows jsdom's implementation (and vitest aliases `window` to `globalThis`,
// so `window.localStorage` is the same broken native one). Pin a minimal
// in-memory Storage onto the global so the bare `localStorage` reference (used
// by both LocalStorageStore and these tests) works regardless of Node version
// or flags. This still exercises the store's real logic (prefixing, round-trip).
beforeAll(() => {
  const data = new Map<string, string>()
  const storage: Storage = {
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  })
})

describe('LocalStorageStore', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips and deletes with a namespaced prefix', async () => {
    const s = new LocalStorageStore('t:')
    await s.set('a', '1')
    expect(await s.get('a')).toBe('1')
    expect(localStorage.getItem('t:a')).toBe('1')
    await s.delete('a')
    expect(await s.get('a')).toBeNull()
  })

  it('returns null for a missing key', async () => {
    const s = new LocalStorageStore()
    expect(await s.get('nope')).toBeNull()
  })
})

describe('IndexedDBStore', () => {
  it('round-trips and deletes', async () => {
    const s = new IndexedDBStore({ dbName: 'test-db' })
    await s.set('k', 'v')
    expect(await s.get('k')).toBe('v')
    await s.delete('k')
    expect(await s.get('k')).toBeNull()
  })

  it('returns null for a missing key', async () => {
    const s = new IndexedDBStore({ dbName: 'test-db-2' })
    expect(await s.get('absent')).toBeNull()
  })
})
