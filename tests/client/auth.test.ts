import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientCredentials } from 'fastmcp-ts/client'
import type { OAuthToken, TokenStorageAdapter } from 'fastmcp-ts/client'

describe('Client — Authentication', () => {
  describe('Bearer token', () => {
    it.todo('a token string passed to auth is sent as Authorization: Bearer <token>')
    it.todo('does not prepend Bearer if the string already includes it')
  })

  describe('BearerAuth class', () => {
    it.todo('attaches the token to HTTP requests')
    it.todo('can be used in place of a raw token string')
  })

  describe('Custom headers', () => {
    it.todo('arbitrary headers passed to the transport are forwarded on every request')
  })

  describe('OAuth 2.1 + PKCE', () => {
    it.todo('opens the browser to the authorization URL to obtain user consent')
    it.todo('exchanges the authorization code for tokens using PKCE (RFC 7636)')
    it.todo('dynamically registers the client when no client_id is provided (RFC 7591)')
    it.todo('automatically refreshes the access token when it expires')
    it.todo('persists tokens to the configured storage backend')
    it.todo('loads existing tokens from storage and skips the auth flow when valid')
    it.todo('requests the configured scopes during authorization')
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTokenResponse(
  overrides: Partial<OAuthToken> = {},
): Partial<OAuthToken> {
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
// ClientCredentials tests
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
    // First token expires very soon (within the 60s default buffer)
    const soonMs = Date.now() + 30 * 1000 // 30 seconds from now
    mockFetchOnce(makeTokenResponse({ expires_at: soonMs, expires_in: undefined }))
    // Second fetch returns a fresh token
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
    // Token expires well outside the 60s buffer
    const futureMs = Date.now() + 10 * 60 * 1000 // 10 minutes
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
    // Token expires 90 seconds from now — outside the 60s default but inside a 120s buffer
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
    // Delay the response slightly so all concurrent calls are in-flight simultaneously
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

  it('uses a custom tokenStorageAdapter to persist the token', async () => {
    mockFetchOnce(makeTokenResponse())

    const stored: { token: OAuthToken | null } = { token: null }
    const adapter: TokenStorageAdapter = {
      async getToken() {
        return stored.token
      },
      async setToken(t) {
        stored.token = t
      },
    }

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      tokenStorageAdapter: adapter,
    })

    await auth.getHeaders()

    expect(stored.token).not.toBeNull()
    expect(stored.token?.access_token).toBe('test-access-token')
  })

  it('loads an existing valid token from storage without fetching', async () => {
    const futureMs = Date.now() + 10 * 60 * 1000
    const existingToken: OAuthToken = {
      access_token: 'stored-token',
      token_type: 'Bearer',
      expires_at: futureMs,
    }

    const adapter: TokenStorageAdapter = {
      async getToken() {
        return existingToken
      },
      async setToken() {},
    }

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      tokenStorageAdapter: adapter,
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
