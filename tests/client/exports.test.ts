import { describe, it, expect } from 'vitest'
import * as client from 'fastmcp-ts/client'

describe('client public exports', () => {
  it('exposes browser auth primitives', () => {
    expect(typeof client.BrowserOAuth).toBe('function')
    expect(typeof client.IndexedDBStore).toBe('function')
    expect(typeof client.LocalStorageStore).toBe('function')
    expect(typeof client.handleOAuthCallback).toBe('function')
  })

  it('still exposes existing symbols', () => {
    expect(typeof client.Client).toBe('function')
    expect(typeof client.OAuth).toBe('function')
    expect(typeof client.BearerAuth).toBe('function')
    expect(typeof client.ClientCredentials).toBe('function')
    expect(typeof client.FileTokenStorage).toBe('function')
    expect(typeof client.InMemoryStore).toBe('function')
  })
})
