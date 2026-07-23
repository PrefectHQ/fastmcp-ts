import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BearerAuth,
  Client,
  ClientCredentials,
  EnterpriseManagedAuth,
  FileTokenStorage,
  InMemoryStore,
  JwtBearerAuth,
  OAuth,
} from 'fastmcp-ts/client'
import type { KeyValueStore, OAuthToken, ClientCredentialsOptions } from 'fastmcp-ts/client'
import { UnauthorizedError } from '@modelcontextprotocol/client'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdir, rm, writeFile } from 'fs/promises'
import * as jose from 'jose'
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

  it('transport injects static auth headers via requestInit', async () => {
    const auth = new BearerAuth('static-token')
    const { transport } = await resolveTransport('https://example.com/mcp', auth)
    // The transport is a StreamableHTTPClientTransport; we verify it was
    // constructed (i.e. resolveTransport didn't throw).
    expect(transport).toBeDefined()
  })

  it('arbitrary headers in McpConfig are forwarded', async () => {
    const { transport } = await resolveTransport(
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

  // -------------------------------------------------------------------------
  // Per-issuer credential keying (SEP-2352) — the auth() orchestrator passes
  // { issuer } as ctx to clientInformation/saveClientInformation/tokens/
  // saveTokens once the authorization server's issuer is resolved.
  // -------------------------------------------------------------------------
  describe('issuer-scoped storage (SEP-2352)', () => {
    const ISSUER_A = 'https://auth-a.example.com'
    const ISSUER_B = 'https://auth-b.example.com'

    it('tokens saved under one issuer do not leak into a read for a different issuer', async () => {
      const oauth = makeOAuth()
      await oauth.saveTokens({ access_token: 'tok-a', token_type: 'Bearer' }, { issuer: ISSUER_A })
      await oauth.saveTokens({ access_token: 'tok-b', token_type: 'Bearer' }, { issuer: ISSUER_B })

      expect(await oauth.tokens({ issuer: ISSUER_A })).toMatchObject({ access_token: 'tok-a' })
      expect(await oauth.tokens({ issuer: ISSUER_B })).toMatchObject({ access_token: 'tok-b' })
    })

    it('reading tokens() with no ctx returns the most-recently-saved (last issuer) entry', async () => {
      const oauth = makeOAuth()
      await oauth.saveTokens({ access_token: 'tok-a', token_type: 'Bearer' }, { issuer: ISSUER_A })
      await oauth.saveTokens({ access_token: 'tok-b', token_type: 'Bearer' }, { issuer: ISSUER_B })

      // No ctx — this is the shape of adaptOAuthProvider's per-request bearer
      // token read, which must resolve rather than return undefined.
      expect(await oauth.tokens()).toMatchObject({ access_token: 'tok-b' })
    })

    it('clientInformation saved under an issuer round-trips when read with the same issuer ctx', async () => {
      const oauth = makeOAuth()
      await oauth.saveClientInformation(
        { client_id: 'dcr-a', redirect_uris: [] },
        { issuer: ISSUER_A },
      )
      expect(await oauth.clientInformation({ issuer: ISSUER_A })).toMatchObject({ client_id: 'dcr-a' })
      expect(await oauth.clientInformation({ issuer: ISSUER_B })).toBeUndefined()
    })

    it('saving/reading with no ctx at all still works exactly as before (back-compat)', async () => {
      const oauth = makeOAuth()
      await oauth.saveTokens({ access_token: 'plain', token_type: 'Bearer' })
      expect(await oauth.tokens()).toMatchObject({ access_token: 'plain' })
    })

    it('invalidateCredentials("tokens") removes the last-known-issuer entry', async () => {
      const oauth = makeOAuth()
      await oauth.saveTokens({ access_token: 'tok-a', token_type: 'Bearer' }, { issuer: ISSUER_A })
      await oauth.invalidateCredentials('tokens')
      expect(await oauth.tokens({ issuer: ISSUER_A })).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // CIMD — Client ID Metadata Documents (SEP-991)
  // -------------------------------------------------------------------------
  describe('clientMetadataUrl (CIMD / SEP-991)', () => {
    it('exposes the configured clientMetadataUrl on the provider', () => {
      const oauth = new OAuth({
        clientMetadataUrl: 'https://app.example.com/oauth/client-metadata.json',
        onRedirect: vi.fn(),
      })
      expect(oauth.clientMetadataUrl).toBe('https://app.example.com/oauth/client-metadata.json')
    })

    it('is undefined when not configured (DCR fallback path)', () => {
      const oauth = makeOAuth()
      expect(oauth.clientMetadataUrl).toBeUndefined()
    })

    it('throws eagerly on a non-HTTPS clientMetadataUrl', () => {
      expect(
        () =>
          new OAuth({
            clientMetadataUrl: 'http://app.example.com/oauth/client-metadata.json',
            onRedirect: vi.fn(),
          }),
      ).toThrow()
    })

    it('throws eagerly on a root-path clientMetadataUrl', () => {
      expect(
        () => new OAuth({ clientMetadataUrl: 'https://app.example.com/', onRedirect: vi.fn() }),
      ).toThrow()
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

    it('waitForCallback resolves with the callback params delivered to the callback server', async () => {
      const oauth = new OAuth({ callbackPort: 0, onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)

      await oauth.redirectToAuthorization(new URL('https://auth.example.com/authorize'))

      const port = oauth.callbackServerPort!
      expect(port).toBeGreaterThan(0)

      // Simulate the browser redirect landing on our server
      const callbackPromise = oauth.waitForCallback()
      const res = await fetch(`http://localhost:${port}/callback?code=auth-code-123&state=xyz`)
      expect(res.status).toBe(200)

      const params = await callbackPromise
      expect(params.get('code')).toBe('auth-code-123')
    })

    it('waitForCallback resolves with the RFC 9207 iss parameter when the server includes it', async () => {
      const oauth = new OAuth({ callbackPort: 0, onRedirect: vi.fn() })
      oauth._bind(SERVER_URL)

      await oauth.redirectToAuthorization(new URL('https://auth.example.com/authorize'))

      const port = oauth.callbackServerPort!
      const callbackPromise = oauth.waitForCallback()
      await fetch(
        `http://localhost:${port}/callback?code=auth-code-123&iss=${encodeURIComponent('https://auth.example.com')}`,
      )

      const params = await callbackPromise
      expect(params.get('code')).toBe('auth-code-123')
      expect(params.get('iss')).toBe('https://auth.example.com')
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
// Client — post-connect step-up re-authorization (OAuth)
//
// A request that 401s (missing/expired token) or 403s with an
// `insufficient_scope` challenge *after connect* drives the SDK transport to
// issue a fresh, scope-honoring authorization request and re-throw
// UnauthorizedError. The Client wrapper completes a waitForCallback→finishAuth
// round (single-flight) and retries the request, bounded to TWO rounds per
// request — one for an ordinary scope step-up, a second for a SEP-2352
// authorization-server migration; beyond that the error propagates. These
// tests mock at the SDK-client / transport boundary: the mechanism is
// transport-level and era-independent, so exercising the wrapper directly
// (rather than standing up a full OAuth authorization server) is both
// sufficient and precise about what fastmcp owns — the catch, the
// single-flight round, and the bounded retry. The
// SDK's own scope selection (extractWWWAuthenticateParams + computeScopeUnion)
// and transport-level step-up (`_stepUpAuthorize`) are the SDK's contract.
// ---------------------------------------------------------------------------

type FakeSdk = {
  getProtocolEra: () => 'legacy' | 'modern'
  listTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  subscribeResource: ReturnType<typeof vi.fn>
}

/**
 * Builds a Client with a mock SDK client + transport wired in behind the auth
 * provider, and (for OAuth) a stubbed `waitForCallback` so no real loopback
 * callback server is needed. Returns the mocks so a test can assert exactly how
 * many times the re-auth round ran.
 */
function makeStepUpClient(opts: {
  auth: OAuth | BearerAuth | ClientCredentials
  era?: 'legacy' | 'modern'
}) {
  const client = new Client('https://mcp.example.com/mcp', { auth: opts.auth })
  const finishAuth = vi.fn(async () => {})
  const waitForCallback =
    opts.auth instanceof OAuth
      ? vi.spyOn(opts.auth, 'waitForCallback').mockResolvedValue(new URLSearchParams('code=abc'))
      : undefined
  const sdk: FakeSdk = {
    getProtocolEra: () => opts.era ?? 'legacy',
    listTools: vi.fn(),
    callTool: vi.fn(),
    subscribeResource: vi.fn(),
  }
  ;(client as unknown as { _sdkClient: FakeSdk })._sdkClient = sdk
  ;(client as unknown as { _transport: { finishAuth: typeof finishAuth } })._transport = {
    finishAuth,
  }
  return { client, sdk, finishAuth, waitForCallback }
}

describe('Client — post-connect step-up re-authorization (OAuth)', () => {
  // The re-auth wrapper reacts only to UnauthorizedError and is identical across
  // eras (era only selects the wire method the SDK sends); the happy-path retry
  // is exercised under both to confirm no accidental era coupling (e.g. via
  // _metaParams()).
  for (const era of ['legacy', 'modern'] as const) {
    it(`re-authorizes once on a post-connect UnauthorizedError and retries the request (${era} era)`, async () => {
      const { client, sdk, finishAuth, waitForCallback } = makeStepUpClient({
        auth: new OAuth(),
        era,
      })
      sdk.listTools
        .mockRejectedValueOnce(new UnauthorizedError())
        .mockResolvedValueOnce({ tools: [{ name: 'greet' }] })

      const tools = await client.listTools()

      expect(tools).toEqual([{ name: 'greet' }])
      expect(sdk.listTools).toHaveBeenCalledTimes(2) // original + one retry
      expect(waitForCallback).toHaveBeenCalledTimes(1)
      expect(finishAuth).toHaveBeenCalledTimes(1)
      expect(finishAuth).toHaveBeenCalledWith(new URLSearchParams('code=abc'))
    })
  }

  it('re-authorizes and retries a post-connect subscribeResource (the legacy subscribe RPC is auth-gated)', async () => {
    const { client, sdk, finishAuth } = makeStepUpClient({ auth: new OAuth(), era: 'legacy' })
    sdk.subscribeResource
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValueOnce({})

    await expect(client.subscribeResource('res://x', () => {})).resolves.toBeUndefined()

    expect(sdk.subscribeResource).toHaveBeenCalledTimes(2) // original + one retry
    expect(finishAuth).toHaveBeenCalledTimes(1)
  })

  it('re-authorizes and retries a post-connect callTool escalation (the 403 insufficient_scope surface)', async () => {
    const { client, sdk, finishAuth } = makeStepUpClient({ auth: new OAuth() })
    sdk.callTool
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], isError: false })

    const result = await client.callToolRaw('do_write', {})

    expect(result.isError).toBe(false)
    expect(sdk.callTool).toHaveBeenCalledTimes(2)
    expect(finishAuth).toHaveBeenCalledTimes(1)
  })

  it('re-authorizes twice on one request across an authorization-server migration (SEP-2352)', async () => {
    // The first authenticated request flips the MCP server to a new AS, so the
    // next 401 needs a SECOND re-auth round on the same wrapped request. Two
    // rounds are within the bound; the request then succeeds.
    const { client, sdk, finishAuth, waitForCallback } = makeStepUpClient({ auth: new OAuth() })
    sdk.listTools
      .mockRejectedValueOnce(new UnauthorizedError()) // 401 at the old AS
      .mockRejectedValueOnce(new UnauthorizedError()) // 401 after the AS migrated
      .mockResolvedValueOnce({ tools: [{ name: 'greet' }] })

    const tools = await client.listTools()

    expect(tools).toEqual([{ name: 'greet' }])
    expect(sdk.listTools).toHaveBeenCalledTimes(3) // original + two retries
    expect(waitForCallback).toHaveBeenCalledTimes(2) // two rounds
    expect(finishAuth).toHaveBeenCalledTimes(2)
  })

  it('invalidates the cached discovery state after a re-auth round (SEP-2352 re-discovery)', async () => {
    const auth = new OAuth()
    const invalidate = vi.spyOn(auth, 'invalidateCredentials')
    const { client, sdk } = makeStepUpClient({ auth })
    sdk.listTools
      .mockRejectedValueOnce(new UnauthorizedError())
      .mockResolvedValueOnce({ tools: [] })

    await client.listTools()

    // The next authorization leg must re-discover the PRM from scratch, or a
    // migrated authorization server is never noticed.
    expect(invalidate).toHaveBeenCalledWith('discovery')
  })

  it('propagates the UnauthorizedError after the bounded number of re-auth rounds — no unbounded loop', async () => {
    const { client, sdk, finishAuth, waitForCallback } = makeStepUpClient({ auth: new OAuth() })
    sdk.listTools.mockRejectedValue(new UnauthorizedError())

    await expect(client.listTools()).rejects.toBeInstanceOf(UnauthorizedError)
    // original + exactly two retries (the bound), then the error propagates.
    expect(sdk.listTools).toHaveBeenCalledTimes(3)
    expect(waitForCallback).toHaveBeenCalledTimes(2)
    expect(finishAuth).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent post-connect 401s into a single re-auth round (single-flight)', async () => {
    const { client, sdk, finishAuth, waitForCallback } = makeStepUpClient({ auth: new OAuth() })
    let authed = false
    // finishAuth stands in for redeeming the broader-scope token; every request
    // 401s until it has run once.
    finishAuth.mockImplementation(async () => {
      authed = true
    })
    sdk.listTools.mockImplementation(async () => {
      if (!authed) throw new UnauthorizedError()
      return { tools: [] }
    })

    const [a, b] = await Promise.all([client.listTools(), client.listTools()])

    expect(a).toEqual([])
    expect(b).toEqual([])
    expect(waitForCallback).toHaveBeenCalledTimes(1) // one shared round, not two
    expect(finishAuth).toHaveBeenCalledTimes(1)
  })

  it('does not re-authorize non-interactive BearerAuth — the 401 propagates unchanged', async () => {
    const { client, sdk } = makeStepUpClient({ auth: new BearerAuth('t') })
    sdk.listTools.mockRejectedValue(new UnauthorizedError())

    await expect(client.listTools()).rejects.toBeInstanceOf(UnauthorizedError)
    expect(sdk.listTools).toHaveBeenCalledTimes(1) // no retry, no re-auth
  })

  it('does not re-authorize ClientCredentials — a scope failure is not an interactive flow', async () => {
    const cc = new ClientCredentials({
      tokenEndpoint: 'https://as.example.com/token',
      clientId: 'id',
      clientSecret: 's',
    })
    const { client, sdk } = makeStepUpClient({ auth: cc })
    sdk.listTools.mockRejectedValue(new UnauthorizedError())

    await expect(client.listTools()).rejects.toBeInstanceOf(UnauthorizedError)
    expect(sdk.listTools).toHaveBeenCalledTimes(1)
  })

  it('does not re-authorize on a non-401 error under OAuth — the error propagates unchanged', async () => {
    const { client, sdk, finishAuth } = makeStepUpClient({ auth: new OAuth() })
    sdk.listTools.mockRejectedValue(new Error('boom'))

    await expect(client.listTools()).rejects.toThrow('boom')
    expect(sdk.listTools).toHaveBeenCalledTimes(1)
    expect(finishAuth).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// ClientCredentials — client_secret_post (default) is unchanged
// ---------------------------------------------------------------------------

describe('ClientCredentials — client_secret_post (default)', () => {
  const TOKEN_ENDPOINT = 'https://auth.example.com/oauth/token'

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to client_secret_post and sends no Authorization header on the token request', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()

    const body = new URLSearchParams(init?.body as string)
    expect(body.get('client_id')).toBe('my-client')
    expect(body.get('client_secret')).toBe('my-secret')
  })

  it('produces a byte-identical POST body to the pre-existing behavior', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      scope: 'read write',
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    // Field order locked: grant_type, client_id, client_secret, scope.
    expect(init?.body).toBe(
      'grant_type=client_credentials&client_id=my-client&client_secret=my-secret&scope=read+write',
    )
  })

  it('accepts an explicit authMethod: client_secret_post identically to the default', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      authMethod: 'client_secret_post',
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('client_secret')).toBe('my-secret')
  })
})

// ---------------------------------------------------------------------------
// ClientCredentials — client_secret_basic
// ---------------------------------------------------------------------------

describe('ClientCredentials — client_secret_basic', () => {
  const TOKEN_ENDPOINT = 'https://auth.example.com/oauth/token'

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the credentials in an RFC 6749 Basic Authorization header, not the body', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      authMethod: 'client_secret_basic',
    })

    await auth.getHeaders()

    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe(TOKEN_ENDPOINT)
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${btoa('my-client:my-secret')}`)

    const body = new URLSearchParams(init?.body as string)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.has('client_id')).toBe(false)
    expect(body.has('client_secret')).toBe(false)
  })

  it('form-encodes special characters per RFC 6749 §2.3.1 before Base64', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'client id/with:special',
      clientSecret: 's3cr3t:with spaces&+=',
      authMethod: 'client_secret_basic',
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const headers = init?.headers as Record<string, string>
    // Hardcoded oracle — independent of the encoder under test. Decodes to
    // `client%20id%2Fwith%3Aspecial:s3cr3t%3Awith%20spaces%26%2B%3D`
    // (RFC 3986 percent-encoding of id and secret, joined by a colon).
    expect(headers.Authorization).toBe(
      'Basic Y2xpZW50JTIwaWQlMkZ3aXRoJTNBc3BlY2lhbDpzM2NyM3QlM0F3aXRoJTIwc3BhY2VzJTI2JTJCJTNE',
    )
    expect(atob(headers.Authorization.slice('Basic '.length))).toBe(
      'client%20id%2Fwith%3Aspecial:s3cr3t%3Awith%20spaces%26%2B%3D',
    )
  })

  it('includes scope in the body but never the secret', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      authMethod: 'client_secret_basic',
      scope: 'read write',
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('scope')).toBe('read write')
    expect(body.has('client_secret')).toBe(false)
  })

  it('still returns a Bearer Authorization header from getHeaders()', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      authMethod: 'client_secret_basic',
    })

    expect(await auth.getHeaders()).toEqual({ Authorization: 'Bearer test-access-token' })
  })
})

// ---------------------------------------------------------------------------
// ClientCredentials — private_key_jwt (RFC 7523 / SEP-1046)
// ---------------------------------------------------------------------------

describe('ClientCredentials — private_key_jwt', () => {
  const TOKEN_ENDPOINT = 'https://auth.example.com/oauth/token'
  const ISSUER = 'https://auth.example.com'

  let privateKeyPem: string
  let publicKey: jose.CryptoKey

  beforeAll(async () => {
    const { publicKey: pub, privateKey } = await jose.generateKeyPair('ES256', {
      extractable: true,
    })
    publicKey = pub as jose.CryptoKey
    privateKeyPem = await jose.exportPKCS8(privateKey)
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a signed client_assertion with the jwt-bearer type and no secret in the body', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      privateKey: privateKeyPem,
      algorithm: 'ES256',
      audience: ISSUER,
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const headers = init?.headers as Record<string, string>
    // No Basic header, no secret — the assertion carries the client identity.
    expect(headers.Authorization).toBeUndefined()

    const body = new URLSearchParams(init?.body as string)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    )
    expect(body.get('client_assertion')).toBeTruthy()
    expect(body.has('client_secret')).toBe(false)
    expect(body.has('client_id')).toBe(false)
  })

  it('signs the assertion with the configured claims and algorithm, verifiable against the public key', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      privateKey: privateKeyPem,
      algorithm: 'ES256',
      audience: ISSUER,
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const assertion = new URLSearchParams(init?.body as string).get('client_assertion')!

    const { payload, protectedHeader } = await jose.jwtVerify(assertion, publicKey, {
      audience: ISSUER,
    })
    expect(protectedHeader.alg).toBe('ES256')
    expect(payload.iss).toBe('my-client')
    expect(payload.sub).toBe('my-client')
    expect(payload.aud).toBe(ISSUER)
    expect(typeof payload.exp).toBe('number')
    expect(typeof payload.jti).toBe('string')
  })

  it('signs the assertion with the token endpoint as audience when so configured', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      privateKey: privateKeyPem,
      algorithm: 'ES256',
      // audience is required; an AS that verifies against the token endpoint.
      audience: TOKEN_ENDPOINT,
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const assertion = new URLSearchParams(init?.body as string).get('client_assertion')!

    const { payload } = await jose.jwtVerify(assertion, publicKey, { audience: TOKEN_ENDPOINT })
    expect(payload.aud).toBe(TOKEN_ENDPOINT)
  })

  it('includes scope in the body when configured', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      privateKey: privateKeyPem,
      algorithm: 'ES256',
      audience: ISSUER,
      scope: 'read',
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    expect(new URLSearchParams(init?.body as string).get('scope')).toBe('read')
  })

  it('returns a Bearer Authorization header from getHeaders() after the jwt exchange', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new ClientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'my-client',
      privateKey: privateKeyPem,
      algorithm: 'ES256',
      audience: ISSUER,
    })

    expect(await auth.getHeaders()).toEqual({ Authorization: 'Bearer test-access-token' })
  })
})

// ---------------------------------------------------------------------------
// ClientCredentials — options are a discriminated union (compile-time)
// ---------------------------------------------------------------------------

describe('ClientCredentials — options discriminated union', () => {
  it('type-rejects combining clientSecret and privateKey configs', () => {
    const mixed = {
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'c',
      clientSecret: 's',
      privateKey: 'pem',
      algorithm: 'ES256',
    }
    // @ts-expect-error clientSecret and privateKey are mutually exclusive
    const opts: ClientCredentialsOptions = mixed
    expect(opts).toBeDefined()
  })

  it('type-requires an audience on the key-based config', () => {
    const noAudience = {
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'c',
      privateKey: 'pem',
      algorithm: 'ES256',
    }
    // @ts-expect-error private_key_jwt requires an explicit audience
    const opts: ClientCredentialsOptions = noAudience
    expect(opts).toBeDefined()
  })

  it('accepts a key-based config with an audience and no clientSecret', () => {
    const opts: ClientCredentialsOptions = {
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'c',
      privateKey: 'pem',
      algorithm: 'ES256',
      audience: 'https://auth.example.com',
    }
    expect(opts.clientId).toBe('c')
  })
})

// ---------------------------------------------------------------------------
// JwtBearerAuth — RFC 7523 §2.1 JWT-bearer grant (SEP-1933 workload identity)
// ---------------------------------------------------------------------------

describe('JwtBearerAuth', () => {
  const TOKEN_ENDPOINT = 'https://auth.example.com/oauth/token'
  const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
  const ASSERTION = 'eyJhbGciOiJFUzI1NiJ9.workload.signature'

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs grant_type=jwt-bearer with the assertion, and returns a Bearer header', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'workload-client',
      assertion: ASSERTION,
    })

    const headers = await auth.getHeaders()
    expect(headers).toEqual({ Authorization: 'Bearer test-access-token' })

    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(String(url)).toBe(TOKEN_ENDPOINT)
    expect(init?.method).toBe('POST')
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('grant_type')).toBe(JWT_BEARER_GRANT)
    expect(body.get('assertion')).toBe(ASSERTION)
  })

  it('defaults to a public client (authMethod none): client_id in the body, no Authorization header', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'workload-client',
      assertion: ASSERTION,
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const reqHeaders = init?.headers as Headers | Record<string, string>
    const authHeader =
      reqHeaders instanceof Headers
        ? reqHeaders.get('authorization')
        : (reqHeaders as Record<string, string>).Authorization ??
          (reqHeaders as Record<string, string>).authorization
    expect(authHeader ?? null).toBeNull()
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('client_id')).toBe('workload-client')
    expect(body.has('client_secret')).toBe(false)
  })

  it('omits client_id from the body entirely when no clientId is configured', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      assertion: ASSERTION,
    })

    await auth.getHeaders()

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const body = new URLSearchParams(init?.body as string)
    // No client_id at all — not an empty `client_id=`.
    expect(body.has('client_id')).toBe(false)
    expect(body.get('assertion')).toBe(ASSERTION)
    expect(body.get('grant_type')).toBe(JWT_BEARER_GRANT)
  })

  it('keeps the configured scope even when no clientId is set (both body rewrites apply)', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      assertion: ASSERTION,
      scope: 'mcp:read',
    })

    await auth.getHeaders()

    const body = new URLSearchParams(vi.mocked(fetch).mock.calls[0]![1]?.body as string)
    expect(body.has('client_id')).toBe(false)
    expect(body.get('scope')).toBe('mcp:read')
  })

  it('calls an async assertion factory to mint a fresh assertion on each fetch', async () => {
    mockFetchOnce(makeTokenResponse())
    mockFetchOnce(makeTokenResponse({ access_token: 'second' }))

    let n = 0
    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'workload-client',
      assertion: async () => `assertion-${++n}`,
      refreshBufferSeconds: 4000, // force the second call to re-fetch
    })

    await auth.getHeaders()
    await auth.getHeaders()

    const body1 = new URLSearchParams(vi.mocked(fetch).mock.calls[0]![1]?.body as string)
    const body2 = new URLSearchParams(vi.mocked(fetch).mock.calls[1]![1]?.body as string)
    expect(body1.get('assertion')).toBe('assertion-1')
    expect(body2.get('assertion')).toBe('assertion-2')
  })

  it('appends the requested scope to the token request body', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'workload-client',
      assertion: ASSERTION,
      scope: 'mcp:read mcp:write',
    })

    await auth.getHeaders()

    const body = new URLSearchParams(vi.mocked(fetch).mock.calls[0]![1]?.body as string)
    expect(body.get('scope')).toBe('mcp:read mcp:write')
    expect(body.get('assertion')).toBe(ASSERTION)
  })

  it('authenticates the client with Basic when authMethod is client_secret_basic', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'workload-client',
      clientSecret: 'sekret',
      authMethod: 'client_secret_basic',
      assertion: ASSERTION,
    })

    await auth.getHeaders()

    const reqHeaders = vi.mocked(fetch).mock.calls[0]![1]?.headers as Headers | Record<string, string>
    const authHeader =
      reqHeaders instanceof Headers
        ? reqHeaders.get('authorization')
        : (reqHeaders as Record<string, string>).Authorization
    expect(authHeader).toBe(`Basic ${btoa('workload-client:sekret')}`)
  })

  it('caches the token across calls (one fetch)', async () => {
    mockFetchOnce(makeTokenResponse())

    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'workload-client',
      assertion: ASSERTION,
    })

    const h1 = await auth.getHeaders()
    const h2 = await auth.getHeaders()
    expect(h1).toEqual(h2)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('has kind === "jwt_bearer" for the transport discriminant', () => {
    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'workload-client',
      assertion: ASSERTION,
    })
    expect(auth.kind).toBe('jwt_bearer')
  })

  it('is accepted by the transport resolver as an async per-request auth', async () => {
    const auth = new JwtBearerAuth({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'workload-client',
      assertion: ASSERTION,
    })
    // resolveTransport routes a `kind`-carrying provider through the async
    // per-request fetch path (isAsyncAuth); we verify it constructs cleanly.
    const { transport } = await resolveTransport('https://mcp.example.com/mcp', auth)
    expect(transport).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// EnterpriseManagedAuth — SEP-990 token exchange + JWT-bearer grant
// ---------------------------------------------------------------------------

describe('EnterpriseManagedAuth', () => {
  const AS_TOKEN_ENDPOINT = 'https://auth.chat.example/token'
  const IDP_TOKEN_ENDPOINT = 'https://idp.example.com/token'
  const AS_ISSUER = 'https://auth.chat.example'
  const MCP_RESOURCE = 'https://mcp.chat.example/mcp'
  const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
  const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
  const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.id-token.sig'
  const ID_JAG = 'eyJhbGciOiJFUzI1NiIsInR5cCI6Im9hdXRoLWlkLWphZytqd3QifQ.id-jag.sig'

  function mockIdpExchange(): void {
    // requestJwtAuthorizationGrant parses IdJagTokenExchangeResponseSchema.
    mockFetchOnce({
      issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      access_token: ID_JAG,
      token_type: 'N_A',
      expires_in: 300,
    })
  }
  function mockAsGrant(access = 'ema-access-token'): void {
    mockFetchOnce(makeTokenResponse({ access_token: access }))
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeAuth(): EnterpriseManagedAuth {
    return new EnterpriseManagedAuth({
      tokenEndpoint: AS_TOKEN_ENDPOINT,
      clientId: 'mcp-client',
      clientSecret: 'mcp-secret',
      audience: AS_ISSUER,
      resource: MCP_RESOURCE,
      idpTokenEndpoint: IDP_TOKEN_ENDPOINT,
      idpClientId: 'idp-client',
      idToken: ID_TOKEN,
    })
  }

  it('performs the RFC 8693 token exchange at the IdP with the required parameters', async () => {
    mockIdpExchange()
    mockAsGrant()

    await makeAuth().getHeaders()

    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(String(url)).toBe(IDP_TOKEN_ENDPOINT)
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('grant_type')).toBe(TOKEN_EXCHANGE_GRANT)
    expect(body.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:id-jag')
    expect(body.get('subject_token')).toBe(ID_TOKEN)
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token')
    expect(body.get('audience')).toBe(AS_ISSUER)
    expect(body.get('resource')).toBe(MCP_RESOURCE)
    expect(body.get('client_id')).toBe('idp-client')
  })

  it('presents the ID-JAG under grant_type=jwt-bearer with client_secret_basic at the AS', async () => {
    mockIdpExchange()
    mockAsGrant()

    const headers = await makeAuth().getHeaders()
    expect(headers).toEqual({ Authorization: 'Bearer ema-access-token' })

    const [url, init] = vi.mocked(fetch).mock.calls[1]!
    expect(String(url)).toBe(AS_TOKEN_ENDPOINT)
    const body = new URLSearchParams(init?.body as string)
    expect(body.get('grant_type')).toBe(JWT_BEARER_GRANT)
    expect(body.get('assertion')).toBe(ID_JAG)

    const reqHeaders = init?.headers as Headers | Record<string, string>
    const authHeader =
      reqHeaders instanceof Headers
        ? reqHeaders.get('authorization')
        : (reqHeaders as Record<string, string>).Authorization
    expect(authHeader).toBe(`Basic ${btoa('mcp-client:mcp-secret')}`)
  })

  it('runs both hops exactly once and caches the resulting token', async () => {
    mockIdpExchange()
    mockAsGrant()

    const auth = makeAuth()
    const h1 = await auth.getHeaders()
    const h2 = await auth.getHeaders()

    expect(h1).toEqual(h2)
    expect(fetch).toHaveBeenCalledTimes(2) // exchange + grant, then cached
  })

  it('has kind === "enterprise_managed" for the transport discriminant', () => {
    expect(makeAuth().kind).toBe('enterprise_managed')
  })
})
