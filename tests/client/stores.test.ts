// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { LocalStorageStore, IndexedDBStore } from 'fastmcp-ts/client'

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
