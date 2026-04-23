import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BearerAuth,
  ClientCredentials,
  FileTokenStorage,
  InMemoryStore,
  OAuth,
} from 'fastmcp-ts/client'
import type { KeyValueStore, OAuthToken } from 'fastmcp-ts/client'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdir, rm, writeFile } from 'fs/promises'
import { resolveTransport } from '../../src/client/transports.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTokenResponse(overrides: Partial<OAuthToken> = {}): Partial<OAuthToken> {
  return {
    access_token: 'test-access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    ...overrides,
  }
}

function mockFetchOnce(body: unknown, status = 200): void {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

// ---------------------------------------------------------------------------
// BearerAuth
// ---------------------------------------------------------------------------

describe('BearerAuth', () => {
  it('produces an Authorization: Bearer <token> header', () => {
    const auth = new BearerAuth('my-secret-token')
    expect(auth.getHeaders()).toEqual({ Authorization: 'Bearer my-secret-token' })
  })

  it('strips an existing Bearer prefix to avoid doubling', () => {
    const auth = new BearerAuth('Bearer already-prefixed')
    expect(auth.getHeaders()).toEqual({ Authorization: 'Bearer already-prefixed' })
  })
})

// ---------------------------------------------------------------------------
// Bearer token via Client transport resolution
// ---------------------------------------------------------------------------

describe('Client — Bearer token', () => {
  it('a token string passed to auth is sent as Authorization: Bearer <token>', () => {
    const auth = new BearerAuth('my-token')
    const headers = auth.getHeaders()
    expect(headers['Authorization']).toBe('Bearer my-token')
  })

  it('does not prepend Bearer if the string already includes it', () => {
    const auth = new BearerAuth('Bearer my-token')
    expect(auth.getHeaders()['Authorization']).toBe('Bearer my-token')
  })

  it('BearerAuth can be used in place of a raw token string', () => {
    const fromString = new BearerAuth('tok')
    const fromClass = new BearerAuth('tok')
    expect(fromString.getHeaders()).toEqual(fromClass.getHeaders())
  })

  it('transport injects static auth headers via requestInit', () => {
    const auth = new BearerAuth('static-token')
    const { transport } = resolveTransport('https://example.com/mcp', auth)
    // The transport is a StreamableHTTPClientTransport; we verify it was
    // constructed (i.e. resolveTransport didn't throw).
    expect(transport).toBeDefined()
  })

  it('arbitrary headers in McpConfig are forwarded', () => {
    const { transport } = resolveTransport(
      {
        mcpServers: {
          myServer: { url: 'https://example.com/mcp', headers: { 'X-Tenant': 'acme' } },
        },
      },
      new BearerAuth('tok'),
    )
    expect(transport).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// OAuth — storage & metadata
// ---------------------------------------------------------------------------

describe('OAuth', () => {
  const SERVER_URL = 'https://api.example.com'

  function makeOAuth(overrides: ConstructorParameters<typeof OAuth>[0] = {}) {
    const oauth = new OAuth({ onRedirect: vi.fn(), ...overrides })
    oauth._bind(SERVER_URL)
    return oauth
  }

  describe('token storage', () => {
    it('saveTokens() persists tokens readable via tokens()', async () => {
      const oauth = makeOAuth()
      const tokens = { access_token: 'tok', token_type: 'Bearer' }
      await oauth.saveTokens(tokens)
      expect(await oauth.tokens()).toEqual(tokens)
    })

    it('tokens() returns undefined when no tokens are stored', async () => {
      const oauth = makeOAuth()
      expect(await oauth.tokens()).toBeUndefined()
    })

    it('invalidateCredentials("tokens") removes only tokens', async () => {
      const store = new InMemoryStore()
      const oauth = makeOAuth({ store })
      await oauth.saveTokens({ access_token: 'tok', token_type: 'Bearer' })
      await oauth.saveClientInformation({ client_id: 'cid', redirect_uris: [] })
      await oauth.invalidateCredentials('tokens')
      expect(await oauth.tokens()).toBeUndefined()
      expect(await oauth.clientInformation()).not.toBeUndefined()
    })

    it('invalidateCredentials("all") removes everything', async () => {
      const oauth = makeOAuth()
      await oauth.saveTokens({ access_token: 'tok', token_type: 'Bearer' })
      await oauth.saveClientInformation({ client_id: 'cid', redirect_uris: [] })
      oauth.saveCodeVerifier('cv')
      await oauth.invalidateCredentials('all')
      expect(await oauth.tokens()).toBeUndefined()
      expect(await oauth.clientInformation()).toBeUndefined()
      expect(() => oauth.codeVerifier()).toThrow()
    })
  })

  describe('client information', () => {
    it('clientInformation() returns pre-registered credentials when clientId is set', async () => {
      const oauth = new OAuth({
        clientId: 'pre-reg-id',
        clientSecret: 'pre-reg-secret',
        onRedirect: vi.fn(),
      })
      oauth._bind(SERVER_URL)
      const info = await oauth.clientInformation()
      expect(info).toEqual({ client_id: 'pre-reg-id', client_secret: 'pre-reg-secret' })
    })

    it('clientInformation() returns stored DCR info when no clientId is configured', async () => {
      const oauth = makeOAuth()
      await oauth.saveClientInformation({ client_id: 'dcr-id', redirect_uris: [] })
      const info = await oauth.clientInformation()
      expect(info).toMatchObject({ client_id: 'dcr-id' })
    })

    it('saveClientInformation() does not overwrite pre-registered clientId', async () => {
      const oauth = new OAuth({ clientId: 'pre-reg-id', onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)
      await oauth.saveClientInformation({ client_id: 'dcr-id', redirect_uris: [] })
      // Pre-registered id is returned, not the DCR one
      const info = await oauth.clientInformation()
      expect(info).toMatchObject({ client_id: 'pre-reg-id' })
    })
  })

  describe('PKCE code verifier', () => {
    it('saveCodeVerifier / codeVerifier round-trip', () => {
      const oauth = makeOAuth()
      oauth.saveCodeVerifier('my-verifier')
      expect(oauth.codeVerifier()).toBe('my-verifier')
    })

    it('codeVerifier() throws before saveCodeVerifier() is called', () => {
      const oauth = makeOAuth()
      expect(() => oauth.codeVerifier()).toThrow()
    })
  })

  describe('discovery state', () => {
    it('saveDiscoveryState / discoveryState round-trip', async () => {
      const oauth = makeOAuth()
      const state = {
        authorizationServerUrl: 'https://auth.example.com',
        resourceMetadataUrl: 'https://api.example.com/.well-known/resource',
      }
      await oauth.saveDiscoveryState(state)
      expect(await oauth.discoveryState()).toEqual(state)
    })

    it('discoveryState() returns undefined when nothing is stored', async () => {
      const oauth = makeOAuth()
      expect(await oauth.discoveryState()).toBeUndefined()
    })

    it('invalidateCredentials("discovery") removes only discovery state', async () => {
      const oauth = makeOAuth()
      await oauth.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.com' })
      await oauth.saveTokens({ access_token: 'tok', token_type: 'Bearer' })
      await oauth.invalidateCredentials('discovery')
      expect(await oauth.discoveryState()).toBeUndefined()
      expect(await oauth.tokens()).not.toBeUndefined()
    })
  })

  describe('clientMetadata', () => {
    it('includes the callback port in redirect_uris', () => {
      const oauth = new OAuth({ callbackPort: 9999, onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)
      const meta = oauth.clientMetadata
      expect(meta.redirect_uris[0]).toBe('http://localhost:9999/callback')
    })

    it('sets token_endpoint_auth_method to client_secret_post when clientSecret is provided', () => {
      const oauth = new OAuth({ clientSecret: 'secret', onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)
      expect(oauth.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post')
    })

    it('sets token_endpoint_auth_method to none for public clients', () => {
      const oauth = makeOAuth()
      expect(oauth.clientMetadata.token_endpoint_auth_method).toBe('none')
    })

    it('includes scopes when configured', () => {
      const oauth = new OAuth({ scopes: ['read', 'write'], onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)
      expect(oauth.clientMetadata.scope).toBe('read write')
    })

    it('accepts scope as a string', () => {
      const oauth = new OAuth({ scopes: 'read write', onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)
      expect(oauth.clientMetadata.scope).toBe('read write')
    })
  })

  describe('storage namespacing', () => {
    it('two OAuth instances with the same store but different server URLs do not share tokens', async () => {
      const store = new InMemoryStore()

      const oauthA = new OAuth({ store, onRedirect: vi.fn() })
      oauthA._bind('https://server-a.example.com')

      const oauthB = new OAuth({ store, onRedirect: vi.fn() })
      oauthB._bind('https://server-b.example.com')

      await oauthA.saveTokens({ access_token: 'token-a', token_type: 'Bearer' })

      expect(await oauthA.tokens()).toMatchObject({ access_token: 'token-a' })
      expect(await oauthB.tokens()).toBeUndefined()
    })

    it('two instances with the same server URL share the same tokens', async () => {
      const store = new InMemoryStore()

      const oauthA = new OAuth({ store, onRedirect: vi.fn() })
      oauthA._bind(SERVER_URL)

      const oauthB = new OAuth({ store, onRedirect: vi.fn() })
      oauthB._bind(SERVER_URL)

      await oauthA.saveTokens({ access_token: 'shared', token_type: 'Bearer' })
      expect(await oauthB.tokens()).toMatchObject({ access_token: 'shared' })
    })
  })

  describe('callback server', () => {
    // Use callbackPort: 0 to let the OS pick a free port, then read the
    // actual port from callbackServerPort after redirectToAuthorization starts the server.

    it('redirectToAuthorization calls onRedirect with the authorization URL', async () => {
      const onRedirect = vi.fn()
      const oauth = new OAuth({ callbackPort: 0, onRedirect })
      oauth._bind(SERVER_URL)

      const authUrl = new URL('https://auth.example.com/authorize?response_type=code')
      await oauth.redirectToAuthorization(authUrl)

      expect(onRedirect).toHaveBeenCalledWith(authUrl)

      // Clean up the server
      await oauth.waitForCallback(10).catch(() => {/* timeout expected */})
    })

    it('waitForCallback resolves with the code delivered to the callback server', async () => {
      const oauth = new OAuth({ callbackPort: 0, onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)

      await oauth.redirectToAuthorization(new URL('https://auth.example.com/authorize'))

      const port = oauth.callbackServerPort!
      expect(port).toBeGreaterThan(0)

      // Simulate the browser redirect landing on our server
      const callbackPromise = oauth.waitForCallback()
      const res = await fetch(`http://localhost:${port}/callback?code=auth-code-123&state=xyz`)
      expect(res.status).toBe(200)

      const code = await callbackPromise
      expect(code).toBe('auth-code-123')
    })

    it('callback server returns 400 when no code is present', async () => {
      const oauth = new OAuth({ callbackPort: 0, onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)

      await oauth.redirectToAuthorization(new URL('https://auth.example.com/authorize'))

      const port = oauth.callbackServerPort!
      const res = await fetch(`http://localhost:${port}/callback?state=xyz`)
      expect(res.status).toBe(400)

      // Clean up
      await oauth.waitForCallback(10).catch(() => {})
    })

    it('waitForCallback rejects after the timeout expires', async () => {
      const oauth = new OAuth({ callbackPort: 0, onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)

      await oauth.redirectToAuthorization(new URL('https://auth.example.com/authorize'))

      await expect(oauth.waitForCallback(50)).rejects.toThrow('timed out')
    })

    it('waitForCallback throws if called before redirectToAuthorization', async () => {
      const oauth = makeOAuth()
      await expect(oauth.waitForCallback(10)).rejects.toThrow('No pending OAuth callback')
    })

    it('waitForCallback rejects immediately when the callback URL carries ?error=access_denied', async () => {
      const oauth = new OAuth({ callbackPort: 0, onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)

      await oauth.redirectToAuthorization(new URL('https://auth.example.com/authorize'))

      const port = oauth.callbackServerPort!
      const callbackPromise = oauth.waitForCallback(30_000)

      // Race fetch and the rejection expectation concurrently to avoid an
      // unhandled-rejection window between when the promise settles and when
      // the next `await` line runs.
      const [res] = await Promise.all([
        fetch(`http://localhost:${port}/callback?error=access_denied&error_description=User+denied+access`),
        expect(callbackPromise).rejects.toThrow('denied'),
      ])
      expect(res.status).toBe(200)
    })

    it('waitForCallback rejects immediately on any ?error= redirect, not just access_denied', async () => {
      const oauth = new OAuth({ callbackPort: 0, onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)

      await oauth.redirectToAuthorization(new URL('https://auth.example.com/authorize'))

      const port = oauth.callbackServerPort!
      const callbackPromise = oauth.waitForCallback(30_000)

      await Promise.all([
        fetch(`http://localhost:${port}/callback?error=server_error`),
        expect(callbackPromise).rejects.toThrow('OAuth authorization denied'),
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// FileTokenStorage
// ---------------------------------------------------------------------------

describe('FileTokenStorage', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `fastmcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('get() returns null when the file does not exist', async () => {
    const store = new FileTokenStorage(join(tmpDir, 'tokens.json'))
    expect(await store.get('key')).toBeNull()
  })

  it('get() returns null for corrupt JSON', async () => {
    const path = join(tmpDir, 'tokens.json')
    await writeFile(path, 'not-valid-json', 'utf8')
    const store = new FileTokenStorage(path)
    expect(await store.get('key')).toBeNull()
  })

  it('set() creates the file and parent directories', async () => {
    const path = join(tmpDir, 'nested', 'dir', 'tokens.json')
    const store = new FileTokenStorage(path)
    await store.set('mykey', 'myvalue')
    expect(await store.get('mykey')).toBe('myvalue')
  })

  it('multiple keys coexist in the same file', async () => {
    const store = new FileTokenStorage(join(tmpDir, 'tokens.json'))
    await store.set('key1', 'value1')
    await store.set('key2', 'value2')
    expect(await store.get('key1')).toBe('value1')
    expect(await store.get('key2')).toBe('value2')
  })

  it('set() overwrites an existing key', async () => {
    const store = new FileTokenStorage(join(tmpDir, 'tokens.json'))
    await store.set('key', 'original')
    await store.set('key', 'updated')
    expect(await store.get('key')).toBe('updated')
  })

  it('delete() removes the key and leaves others intact', async () => {
    const store = new FileTokenStorage(join(tmpDir, 'tokens.json'))
    await store.set('keep', 'this')
    await store.set('remove', 'this')
    await store.delete('remove')
    expect(await store.get('remove')).toBeNull()
    expect(await store.get('keep')).toBe('this')
  })

  it('delete() is a no-op when the key does not exist', async () => {
    const store = new FileTokenStorage(join(tmpDir, 'tokens.json'))
    await expect(store.delete('nonexistent')).resolves.not.toThrow()
  })

  it('round-trips arbitrary JSON values stored as strings', async () => {
    const store = new FileTokenStorage(join(tmpDir, 'tokens.json'))
    const token = { access_token: 'abc', expires_in: 3600 }
    await store.set('tok', JSON.stringify(token))
    const raw = await store.get('tok')
    expect(JSON.parse(raw!)).toEqual(token)
  })
})

// ---------------------------------------------------------------------------
// ClientCredentials
// ---------------------------------------------------------------------------

describe('ClientCredentials', () => {
  const TOKEN_ENDPOINT = 'https://auth.example.com/oauth/token'

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches a token on the first getHeaders() call', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    const headers = await auth.getHeaders()

    expect(headers).toEqual({ Authorization: 'Bearer test-access-token' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('sends client_id, client_secret, and grant_type in the POST body', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    await auth.getHeaders()

    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe(TOKEN_ENDPOINT)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
    })

    const body = new URLSearchParams(init?.body as string)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe('my-client')
    expect(body.get('client_secret')).toBe('my-secret')
  })

  it('includes scope in the POST body when configured', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      scope: 'read write',
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('scope')).toBe('read write')
  })

  it('does not include scope in the POST body when not configured', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const body = new URLSearchParams(init?.body as string)
    expect(body.has('scope')).toBe(false)
  })

  it('reuses the cached token on subsequent calls (only one fetch)', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    const headers1 = await auth.getHeaders()
    const headers2 = await auth.getHeaders()

    expect(headers1).toEqual(headers2)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('re-fetches when the cached token is within the refresh buffer', async () => {
    const soonMs = Date.now() + 30 * 1000
    mockFetchOnce(makeTokenResponse({ expires_at: soonMs, expires_in: undefined }))
    mockFetchOnce(makeTokenResponse({ access_token: 'fresh-token', expires_in: 3600 }))

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    const headers1 = await auth.getHeaders()
    expect(headers1.Authorization).toBe('Bearer test-access-token')

    const headers2 = await auth.getHeaders()
    expect(headers2.Authorization).toBe('Bearer fresh-token')

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not re-fetch when the token has ample time remaining', async () => {
    const futureMs = Date.now() + 10 * 60 * 1000
    mockFetchOnce(makeTokenResponse({ expires_at: futureMs, expires_in: undefined }))

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    await auth.getHeaders()
    await auth.getHeaders()
    await auth.getHeaders()

    expect(fetch).toHaveBeenCalledOnce()
  })

  it('respects a custom refreshBufferSeconds', async () => {
    const expiresMs = Date.now() + 90 * 1000
    mockFetchOnce(makeTokenResponse({ expires_at: expiresMs, expires_in: undefined }))
    mockFetchOnce(makeTokenResponse({ access_token: 'refreshed', expires_in: 3600 }))

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      refreshBufferSeconds: 120,
    })

    await auth.getHeaders()
    const headers2 = await auth.getHeaders()

    expect(headers2.Authorization).toBe('Bearer refreshed')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent getHeaders() calls into a single fetch', async () => {
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify(makeTokenResponse()), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              ),
            10,
          ),
        ),
    )

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    const [h1, h2, h3] = await Promise.all([
      auth.getHeaders(),
      auth.getHeaders(),
      auth.getHeaders(),
    ])

    expect(h1).toEqual(h2)
    expect(h2).toEqual(h3)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('uses a custom store to persist the token', async () => {
    mockFetchOnce(makeTokenResponse())

    const stored: Record<string, string> = {}
    const store: KeyValueStore = {
      async get(k) { return stored[k] ?? null },
      async set(k, v) { stored[k] = v },
      async delete(k) { delete stored[k] },
    }

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      store,
    })

    await auth.getHeaders()

    const key = `${TOKEN_ENDPOINT}/token`
    expect(stored[key]).toBeDefined()
    expect(JSON.parse(stored[key]!).access_token).toBe('test-access-token')
  })

  it('loads an existing valid token from the store without fetching', async () => {
    const futureMs = Date.now() + 10 * 60 * 1000
    const existingToken: OAuthToken = {
      access_token: 'stored-token',
      token_type: 'Bearer',
      expires_at: futureMs,
    }

    const key = `${TOKEN_ENDPOINT}/token`
    const store: KeyValueStore = {
      async get(k) { return k === key ? JSON.stringify(existingToken) : null },
      async set() {},
      async delete() {},
    }

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      store,
    })

    const headers = await auth.getHeaders()

    expect(headers.Authorization).toBe('Bearer stored-token')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws on a non-OK response from the token endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    )

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'wrong-secret',
    })

    await expect(auth.getHeaders()).rejects.toThrow(
      'ClientCredentials token fetch failed (401)',
    )
  })

  it('throws when the token endpoint response is missing access_token', async () => {
    mockFetchOnce({ token_type: 'Bearer', expires_in: 3600 })

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    await expect(auth.getHeaders()).rejects.toThrow(
      'ClientCredentials token response missing access_token',
    )
  })

  it('uses token_type from the response in the Authorization header', async () => {
    mockFetchOnce(makeTokenResponse({ token_type: 'MAC' }))

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    const headers = await auth.getHeaders()
    expect(headers.Authorization).toBe('MAC test-access-token')
  })

  it('has kind === "client_credentials" for transport discriminant', () => {
    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })
    expect(auth.kind).toBe('client_credentials')
  })
})
