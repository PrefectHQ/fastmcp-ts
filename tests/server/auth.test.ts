import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import {
  FastMCP,
  jwtVerifier,
  introspectionVerifier,
  staticTokenVerifier,
  debugTokenVerifier,
  requireScopes,
  multiAuth,
  oauthProvider,
  oauthProxy,
} from 'fastmcp-ts/server'
import type { AccessToken } from 'fastmcp-ts/server'
import { connectHttpClient, rawPost } from '../helpers/http'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an HTTP GET and return the Location header without following the redirect. */
function getRedirectLocation(url: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url.toString(), (res) => {
        const location = res.headers.location
        res.resume()
        if (!location) reject(new Error(`No Location header (status: ${res.statusCode})`))
        else resolve(location)
      })
      .on('error', reject)
  })
}

/** Generate a PKCE code_verifier and corresponding S256 code_challenge. */
function generatePKCE() {
  const codeVerifier = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

async function createJwksSetup(issuer = 'https://example.com', audience = 'test') {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' }

  const jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve))
  const jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/.well-known/jwks.json`

  async function signToken(overrides: Record<string, unknown> = {}) {
    return new SignJWT({ scope: 'read write', ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('user-123')
      .setExpirationTime('1h')
      .setIssuedAt()
      .sign(privateKey)
  }

  async function signExpiredToken() {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(new Date('2020-01-01'))
      .setExpirationTime(new Date('2020-01-01'))
      .sign(privateKey)
  }

  function close() {
    return new Promise<void>((resolve, reject) =>
      jwksServer.close((err) => (err ? reject(err) : resolve())),
    )
  }

  return { jwksUri, issuer, audience, signToken, signExpiredToken, close }
}

async function startServer(mcp: FastMCP) {
  await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
  const { port, path } = mcp.address!
  return { url: new URL(`http://127.0.0.1:${port}${path}`) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Server — Authentication', () => {
  describe('token validation', () => {
    const cleanup: Array<() => Promise<void>> = []
    afterEach(async () => {
      await Promise.all(cleanup.map((c) => c()))
      cleanup.length = 0
    })

    it('a valid JWT from a trusted issuer grants access to the server', async () => {
      const jwks = await createJwksSetup()
      cleanup.push(jwks.close)

      const mcp = new FastMCP({
        name: 'test-server',
        auth: jwtVerifier({ jwksUri: jwks.jwksUri, issuer: jwks.issuer, audience: jwks.audience }),
      })
      const { url } = await startServer(mcp)
      cleanup.push(() => mcp.close())

      const token = await jwks.signToken()
      const { close } = await connectHttpClient(url, token)
      cleanup.push(close)
    })

    it('an expired or tampered token is rejected', async () => {
      const jwks = await createJwksSetup()
      cleanup.push(jwks.close)

      const mcp = new FastMCP({
        name: 'test-server',
        auth: jwtVerifier({ jwksUri: jwks.jwksUri, issuer: jwks.issuer, audience: jwks.audience }),
      })
      const { url } = await startServer(mcp)
      cleanup.push(() => mcp.close())

      const expiredToken = await jwks.signExpiredToken()
      expect((await rawPost(url, expiredToken)).status).toBe(401)
      expect((await rawPost(url)).status).toBe(401)
      expect((await rawPost(url, 'not-a-jwt')).status).toBe(401)
    })

    it('a static token verifier maps fixed tokens to claim sets (dev/test)', async () => {
      const verifier = staticTokenVerifier({
        'valid-token': { scopes: ['read'], claims: { org: 'acme' } },
      })

      const valid = await verifier.verify('valid-token')
      expect(valid.scopes).toEqual(['read'])
      expect(valid.claims.org).toBe('acme')

      await expect(verifier.verify('unknown')).rejects.toThrow()
    })

    it('staticTokenVerifier rejects a token whose expiresAt is in the past', async () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 60
      const verifier = staticTokenVerifier({
        'expired-token': { scopes: ['read'], expiresAt: pastTimestamp },
      })
      await expect(verifier.verify('expired-token')).rejects.toThrow(/expired/i)
    })

    it('staticTokenVerifier accepts a token whose expiresAt is in the future', async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 3600
      const verifier = staticTokenVerifier({
        'live-token': { scopes: ['read'], expiresAt: futureTimestamp },
      })
      const result = await verifier.verify('live-token')
      expect(result.scopes).toEqual(['read'])
    })

    it('staticTokenVerifier accepts a token with no expiresAt (non-expiring)', async () => {
      const verifier = staticTokenVerifier({ 'permanent-token': { scopes: ['admin'] } })
      const result = await verifier.verify('permanent-token')
      expect(result.scopes).toEqual(['admin'])
    })

    it('a debug token verifier accepts any non-empty bearer token (dev only)', async () => {
      const verifier = debugTokenVerifier()
      const result = await verifier.verify('anything')
      expect(result.token).toBe('anything')
      await expect(verifier.verify('')).rejects.toThrow()
    })

    it('claims from the validated token are available to tools via context', async () => {
      const jwks = await createJwksSetup()
      cleanup.push(jwks.close)

      const mcp = new FastMCP({
        name: 'test-server',
        auth: jwtVerifier({ jwksUri: jwks.jwksUri, issuer: jwks.issuer, audience: jwks.audience }),
      })

      mcp.tool({ name: 'whoami', description: 'Return the caller identity' }, () => {
        const ctx = mcp.getContext()
        return ctx.auth?.claims.sub ?? 'anonymous'
      })

      const { url } = await startServer(mcp)
      cleanup.push(() => mcp.close())

      const token = await jwks.signToken()
      const { client, close } = await connectHttpClient(url, token)
      cleanup.push(close)

      const result = await client.callTool({ name: 'whoami', arguments: {} })
      expect((result.content as unknown[])[0]).toMatchObject({ type: 'text', text: 'user-123' })
    })
  })

  describe('WWW-Authenticate header on 401 responses', () => {
    const cleanup: Array<() => Promise<void>> = []
    afterEach(async () => {
      await Promise.all(cleanup.map((c) => c()))
      cleanup.length = 0
    })

    it('missing bearer token returns 401 with WWW-Authenticate: Bearer realm="mcp"', async () => {
      const mcp = new FastMCP({
        name: 'test-server',
        auth: staticTokenVerifier({ tok: { scopes: [] } }),
      })
      const { url } = await startServer(mcp)
      cleanup.push(() => mcp.close())

      const res = await fetch(url.toString(), { method: 'POST' })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="mcp"')
    })

    it('invalid bearer token returns 401 with WWW-Authenticate: Bearer realm="mcp"', async () => {
      const mcp = new FastMCP({
        name: 'test-server',
        auth: staticTokenVerifier({ tok: { scopes: [] } }),
      })
      const { url } = await startServer(mcp)
      cleanup.push(() => mcp.close())

      const res = await rawPost(url, 'bad-token')
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="mcp"')
    })
  })

  describe('opaque token introspection', () => {
    const cleanup: Array<() => Promise<void>> = []
    afterEach(async () => {
      await Promise.all(cleanup.map((c) => c()))
      cleanup.length = 0
    })

    it('a valid opaque token is verified via an RFC 7662 introspection endpoint', async () => {
      const introspectionServer = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ active: true, scope: 'read', client_id: 'client-abc', exp: 9999999999 }),
        )
      })
      await new Promise<void>((r) => introspectionServer.listen(0, '127.0.0.1', r))
      const port = (introspectionServer.address() as AddressInfo).port
      cleanup.push(
        () => new Promise<void>((r, j) => introspectionServer.close((e) => (e ? j(e) : r()))),
      )

      const verifier = introspectionVerifier({
        endpoint: `http://127.0.0.1:${port}/introspect`,
        credentials: { clientId: 'fastmcp', clientSecret: 'secret' },
      })

      const result = await verifier.verify('opaque-token-xyz')
      expect(result.scopes).toEqual(['read'])
      expect(result.clientId).toBe('client-abc')
    })

    it('a revoked or inactive token is rejected', async () => {
      const introspectionServer = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ active: false }))
      })
      await new Promise<void>((r) => introspectionServer.listen(0, '127.0.0.1', r))
      const port = (introspectionServer.address() as AddressInfo).port
      cleanup.push(
        () => new Promise<void>((r, j) => introspectionServer.close((e) => (e ? j(e) : r()))),
      )

      const verifier = introspectionVerifier({
        endpoint: `http://127.0.0.1:${port}/introspect`,
        credentials: { clientId: 'fastmcp', clientSecret: 'secret' },
      })

      await expect(verifier.verify('revoked-token')).rejects.toThrow('not active')
    })

    it('introspection results can be cached to reduce upstream calls', async () => {
      let callCount = 0
      const introspectionServer = createServer((_req, res) => {
        callCount++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ active: true, scope: 'read' }))
      })
      await new Promise<void>((r) => introspectionServer.listen(0, '127.0.0.1', r))
      const port = (introspectionServer.address() as AddressInfo).port
      cleanup.push(
        () => new Promise<void>((r, j) => introspectionServer.close((e) => (e ? j(e) : r()))),
      )

      const verifier = introspectionVerifier({
        endpoint: `http://127.0.0.1:${port}/introspect`,
        credentials: { clientId: 'fastmcp', clientSecret: 'secret' },
        cacheTtl: 60,
      })

      await verifier.verify('cached-token')
      await verifier.verify('cached-token')
      await verifier.verify('cached-token')

      expect(callCount).toBe(1)
    })
  })

  describe('OAuth with Dynamic Client Registration', () => {
    const cleanup: Array<() => Promise<void>> = []
    afterEach(async () => {
      await Promise.all(cleanup.map((c) => c()))
      cleanup.length = 0
    })

    it('a client without credentials can register dynamically and obtain tokens', async () => {
      const provider = oauthProvider()
      const mcp = new FastMCP({ name: 'test-server', oauth: { provider } })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      cleanup.push(() => mcp.close())

      const baseUrl = `http://127.0.0.1:${mcp.address!.port}`

      // Dynamic Client Registration — public client (no secret)
      const regRes = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://localhost/callback'],
          token_endpoint_auth_method: 'none',
        }),
      })
      expect(regRes.status).toBe(201)
      const clientInfo = (await regRes.json()) as Record<string, string>
      expect(clientInfo.client_id).toBeTruthy()

      // Authorization — auto-approve redirects immediately with a code
      const { codeVerifier, codeChallenge } = generatePKCE()
      const authUrl = new URL(`${baseUrl}/authorize`)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', clientInfo.client_id)
      authUrl.searchParams.set('redirect_uri', 'http://localhost/callback')
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('state', 'test-state')

      const location = await getRedirectLocation(authUrl)
      const code = new URL(location).searchParams.get('code')!
      expect(code).toBeTruthy()
      expect(new URL(location).searchParams.get('state')).toBe('test-state')

      // Token exchange
      const tokenRes = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientInfo.client_id,
          code,
          code_verifier: codeVerifier,
          redirect_uri: 'http://localhost/callback',
        }).toString(),
      })
      expect(tokenRes.status).toBe(200)
      const { access_token } = (await tokenRes.json()) as Record<string, string>
      expect(access_token).toBeTruthy()

      // Use the token to call an MCP tool
      mcp.tool({ name: 'ping', description: 'test tool' }, () => 'pong')
      const { client, close } = await connectHttpClient(
        new URL(`${baseUrl}${mcp.address!.path}`),
        access_token,
      )
      cleanup.push(close)
      const result = await client.callTool({ name: 'ping', arguments: {} })
      expect((result.content as unknown[])[0]).toMatchObject({ type: 'text', text: 'pong' })
    })

    it('registered clients authenticate successfully on subsequent requests', async () => {
      const provider = oauthProvider()
      const mcp = new FastMCP({ name: 'test-server', oauth: { provider } })
      mcp.tool({ name: 'ping', description: 'test tool' }, () => 'pong')
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      cleanup.push(() => mcp.close())

      const baseUrl = `http://127.0.0.1:${mcp.address!.port}`
      const mcpUrl = new URL(`${baseUrl}${mcp.address!.path}`)

      // Register + complete auth flow to obtain a token
      const regRes = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://localhost/callback'],
          token_endpoint_auth_method: 'none',
        }),
      })
      const { client_id } = (await regRes.json()) as Record<string, string>

      const { codeVerifier, codeChallenge } = generatePKCE()
      const authUrl = new URL(`${baseUrl}/authorize`)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', client_id)
      authUrl.searchParams.set('redirect_uri', 'http://localhost/callback')
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')

      const location = await getRedirectLocation(authUrl)
      const code = new URL(location).searchParams.get('code')!

      const tokenRes = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id,
          code,
          code_verifier: codeVerifier,
          redirect_uri: 'http://localhost/callback',
        }).toString(),
      })
      const { access_token } = (await tokenRes.json()) as Record<string, string>

      // Multiple calls with the same token all succeed
      const { client, close } = await connectHttpClient(mcpUrl, access_token)
      cleanup.push(close)
      for (let i = 0; i < 3; i++) {
        const result = await client.callTool({ name: 'ping', arguments: {} })
        expect((result.content as unknown[])[0]).toMatchObject({ type: 'text', text: 'pong' })
      }
    })

    it('a refresh_token grant returns 400 unsupported_grant_type', async () => {
      const provider = oauthProvider()
      const mcp = new FastMCP({ name: 'test-server', oauth: { provider } })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      cleanup.push(() => mcp.close())

      const baseUrl = `http://127.0.0.1:${mcp.address!.port}`

      // Register a client first — the SDK validates client_id before calling exchangeRefreshToken
      const regRes = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' }),
      })
      const { client_id } = (await regRes.json()) as Record<string, string>

      const tokenRes = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id,
          refresh_token: 'some-refresh-token',
        }).toString(),
      })
      expect(tokenRes.status).toBe(400)
      const body = (await tokenRes.json()) as Record<string, string>
      expect(body.error).toBe('unsupported_grant_type')
    })

    it('scopes outside the server-advertised list are stripped from issued tokens', async () => {
      const provider = oauthProvider({ scopes: ['read', 'write'] })
      const mcp = new FastMCP({ name: 'test-server', oauth: { provider } })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      cleanup.push(() => mcp.close())

      const baseUrl = `http://127.0.0.1:${mcp.address!.port}`

      const regRes = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' }),
      })
      const { client_id } = (await regRes.json()) as Record<string, string>

      const { codeVerifier, codeChallenge } = generatePKCE()
      const authUrl = new URL(`${baseUrl}/authorize`)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', client_id)
      authUrl.searchParams.set('redirect_uri', 'http://localhost/callback')
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('scope', 'read admin')

      const location = await getRedirectLocation(authUrl)
      const code = new URL(location).searchParams.get('code')!

      const tokenRes = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id,
          code,
          code_verifier: codeVerifier,
          redirect_uri: 'http://localhost/callback',
        }).toString(),
      })
      expect(tokenRes.status).toBe(200)
      const { scope } = (await tokenRes.json()) as Record<string, string>
      expect(scope.split(' ')).toContain('read')
      expect(scope.split(' ')).not.toContain('admin')
    })

    it('when no scopes are configured, all requested scopes are granted', async () => {
      const provider = oauthProvider()
      const mcp = new FastMCP({ name: 'test-server', oauth: { provider } })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      cleanup.push(() => mcp.close())

      const baseUrl = `http://127.0.0.1:${mcp.address!.port}`

      const regRes = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' }),
      })
      const { client_id } = (await regRes.json()) as Record<string, string>

      const { codeVerifier, codeChallenge } = generatePKCE()
      const authUrl = new URL(`${baseUrl}/authorize`)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', client_id)
      authUrl.searchParams.set('redirect_uri', 'http://localhost/callback')
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('scope', 'read admin custom')

      const location = await getRedirectLocation(authUrl)
      const code = new URL(location).searchParams.get('code')!

      const tokenRes = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id,
          code,
          code_verifier: codeVerifier,
          redirect_uri: 'http://localhost/callback',
        }).toString(),
      })
      const { scope } = (await tokenRes.json()) as Record<string, string>
      expect(scope.split(' ')).toEqual(expect.arrayContaining(['read', 'admin', 'custom']))
    })
  })

  describe('OAuth proxy', () => {
    const cleanup: Array<() => Promise<void>> = []
    afterEach(async () => {
      await Promise.all(cleanup.map((c) => c()))
      cleanup.length = 0
    })

    it('the proxy presents a DCR-compliant interface to MCP clients', async () => {
      const proxy = oauthProxy({
        upstreamCredentials: { clientId: 'proxy-upstream-id' },
        endpoints: {
          authorizationUrl: 'http://127.0.0.1:1/authorize', // not reached in this test
          tokenUrl: 'http://127.0.0.1:1/token',
        },
        verifyAccessToken: async (token) => ({
          token,
          clientId: 'proxy-upstream-id',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      })

      const mcp = new FastMCP({ name: 'test-server', oauth: { provider: proxy } })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      cleanup.push(() => mcp.close())

      const baseUrl = `http://127.0.0.1:${mcp.address!.port}`

      const regRes = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://localhost/callback'],
          token_endpoint_auth_method: 'none',
        }),
      })
      expect(regRes.status).toBe(201)
      const clientInfo = (await regRes.json()) as Record<string, string>
      expect(clientInfo.client_id).toBeTruthy()
    })

    it('the proxy uses pre-registered credentials when talking to the upstream provider', async () => {
      // Mock upstream that captures token exchange requests
      const upstreamRequests: Array<Record<string, string>> = []
      const upstreamServer = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          upstreamRequests.push(Object.fromEntries(new URLSearchParams(body)))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ access_token: 'upstream-token', token_type: 'bearer', expires_in: 3600 }))
        })
      })
      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r))
      const upstreamPort = (upstreamServer.address() as AddressInfo).port
      cleanup.push(
        () => new Promise<void>((r, j) => upstreamServer.close((e) => (e ? j(e) : r()))),
      )

      const proxy = oauthProxy({
        upstreamCredentials: { clientId: 'my-proxy-client', clientSecret: 'my-proxy-secret' },
        endpoints: {
          authorizationUrl: `http://127.0.0.1:${upstreamPort}/authorize`,
          tokenUrl: `http://127.0.0.1:${upstreamPort}/token`,
        },
        verifyAccessToken: async (token) => ({
          token,
          clientId: 'my-proxy-client',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      })

      const mcp = new FastMCP({ name: 'test-server', oauth: { provider: proxy } })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      cleanup.push(() => mcp.close())

      const baseUrl = `http://127.0.0.1:${mcp.address!.port}`

      // Register an MCP client with the proxy
      const regRes = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://localhost/callback'],
          token_endpoint_auth_method: 'none',
        }),
      })
      const { client_id: mcpClientId } = (await regRes.json()) as Record<string, string>

      // Exchange a code via the proxy — it must forward using its pre-registered credentials
      const tokenRes = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: mcpClientId,
          code: 'auth-code-from-upstream',
          code_verifier: 'pkce-verifier',
          redirect_uri: 'http://localhost/callback',
        }).toString(),
      })
      expect(tokenRes.status).toBe(200)

      // The upstream must have received the PROXY's credentials, not the MCP client's
      expect(upstreamRequests).toHaveLength(1)
      expect(upstreamRequests[0].client_id).toBe('my-proxy-client')
      expect(upstreamRequests[0].client_secret).toBe('my-proxy-secret')
      expect(upstreamRequests[0].code).toBe('auth-code-from-upstream')
    })

    it('revokeToken is present when revocationUrl is configured, absent otherwise', () => {
      const withRevocation = oauthProxy({
        upstreamCredentials: { clientId: 'proxy-client', clientSecret: 'proxy-secret' },
        endpoints: {
          authorizationUrl: 'http://127.0.0.1:1/authorize',
          tokenUrl: 'http://127.0.0.1:1/token',
          revocationUrl: 'http://127.0.0.1:1/revoke',
        },
        verifyAccessToken: async (token) => ({
          token,
          clientId: 'proxy-client',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      })
      expect(typeof withRevocation.revokeToken).toBe('function')

      const withoutRevocation = oauthProxy({
        upstreamCredentials: { clientId: 'proxy-client' },
        endpoints: {
          authorizationUrl: 'http://127.0.0.1:1/authorize',
          tokenUrl: 'http://127.0.0.1:1/token',
        },
        verifyAccessToken: async (token) => ({
          token,
          clientId: 'proxy-client',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      })
      expect(withoutRevocation.revokeToken).toBeUndefined()
    })

    it('the proxy forwards revocation to the upstream with proxy credentials', async () => {
      const revokeRequests: Array<Record<string, string>> = []
      const upstreamServer = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          revokeRequests.push(Object.fromEntries(new URLSearchParams(body)))
          res.writeHead(200).end()
        })
      })
      await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r))
      const upstreamPort = (upstreamServer.address() as AddressInfo).port
      cleanup.push(() => new Promise<void>((r, j) => upstreamServer.close((e) => (e ? j(e) : r()))))

      const proxy = oauthProxy({
        upstreamCredentials: { clientId: 'proxy-client', clientSecret: 'proxy-secret' },
        endpoints: {
          authorizationUrl: `http://127.0.0.1:${upstreamPort}/authorize`,
          tokenUrl: `http://127.0.0.1:${upstreamPort}/token`,
          revocationUrl: `http://127.0.0.1:${upstreamPort}/revoke`,
        },
        verifyAccessToken: async (token) => ({
          token,
          clientId: 'proxy-client',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      })

      const mcp = new FastMCP({ name: 'test-server', oauth: { provider: proxy } })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      cleanup.push(() => mcp.close())

      const baseUrl = `http://127.0.0.1:${mcp.address!.port}`

      const regRes = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' }),
      })
      const { client_id: mcpClientId } = (await regRes.json()) as Record<string, string>

      const revokeRes = await fetch(`${baseUrl}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: mcpClientId,
          token: 'access-token-to-revoke',
          token_type_hint: 'access_token',
        }).toString(),
      })
      expect(revokeRes.status).toBe(200)

      expect(revokeRequests).toHaveLength(1)
      expect(revokeRequests[0].client_id).toBe('proxy-client')
      expect(revokeRequests[0].client_secret).toBe('proxy-secret')
      expect(revokeRequests[0].token).toBe('access-token-to-revoke')
      expect(revokeRequests[0].token_type_hint).toBe('access_token')
    })
  })

  describe('scope-based authorization', () => {
    it('requireScopes() grants access when the token carries all required scopes', async () => {
      const check = requireScopes('read', 'write')
      const token: AccessToken = { token: 'x', scopes: ['read', 'write'], claims: {} }
      await expect(check(token)).resolves.toBeUndefined()
    })

    it('requireScopes() denies access when the token is missing a required scope', async () => {
      const check = requireScopes('admin')
      const token: AccessToken = { token: 'x', scopes: ['read'], claims: {} }
      await expect(check(token)).rejects.toThrow('"admin"')
    })

    it('multiple scopes passed to requireScopes() use AND logic — all must be present', async () => {
      const check = requireScopes('read', 'write', 'admin')

      const partial: AccessToken = { token: 'x', scopes: ['read', 'write'], claims: {} }
      await expect(check(partial)).rejects.toThrow('"admin"')

      const full: AccessToken = { token: 'x', scopes: ['read', 'write', 'admin'], claims: {} }
      await expect(check(full)).resolves.toBeUndefined()
    })
  })

  describe('per-component authorization', () => {
    const cleanup: Array<() => Promise<void>> = []
    afterEach(async () => {
      await Promise.all(cleanup.map((c) => c()))
      cleanup.length = 0
    })

    it('a tool registered with an auth check is blocked when the check fails', async () => {
      const mcp = new FastMCP({
        name: 'test-server',
        auth: staticTokenVerifier({
          'reader-token': { scopes: ['read'] },
          'admin-token': { scopes: ['admin'] },
        }),
      })
      mcp.tool({ name: 'admin-tool', description: 'Admin only tool', auth: requireScopes('admin') }, () => 'secret data')
      const { url } = await startServer(mcp)
      cleanup.push(() => mcp.close())

      // Admin token: access granted
      const { client: adminClient, close: closeAdmin } = await connectHttpClient(url, 'admin-token')
      cleanup.push(closeAdmin)
      const ok = await adminClient.callTool({ name: 'admin-tool', arguments: {} })
      expect(ok.isError).not.toBe(true)

      // Reader token: access denied (McpError thrown)
      const { client: readerClient, close: closeReader } = await connectHttpClient(
        url,
        'reader-token',
      )
      cleanup.push(closeReader)
      await expect(readerClient.callTool({ name: 'admin-tool', arguments: {} })).rejects.toThrow()
    })

    it('a resource registered with an auth check is blocked when the check fails', async () => {
      const mcp = new FastMCP({
        name: 'test-server',
        auth: staticTokenVerifier({
          'reader-token': { scopes: ['read'] },
          'admin-token': { scopes: ['admin'] },
        }),
      })
      mcp.resource(
        { name: 'secret', uri: 'secret://data', auth: requireScopes('admin') },
        () => 'classified',
      )
      const { url } = await startServer(mcp)
      cleanup.push(() => mcp.close())

      const { client, close } = await connectHttpClient(url, 'reader-token')
      cleanup.push(close)
      await expect(client.readResource({ uri: 'secret://data' })).rejects.toThrow()
    })

    it('an unauthorized component does not appear in list results', async () => {
      const mcp = new FastMCP({
        name: 'test-server',
        auth: staticTokenVerifier({ 'reader-token': { scopes: ['read'] } }),
      })
      mcp.tool({ name: 'public-tool', description: 'Public tool' }, () => 'public')
      mcp.tool({ name: 'admin-tool', description: 'Admin only tool', auth: requireScopes('admin') }, () => 'secret')
      const { url } = await startServer(mcp)
      cleanup.push(() => mcp.close())

      const { client, close } = await connectHttpClient(url, 'reader-token')
      cleanup.push(close)

      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('public-tool')
      expect(names).not.toContain('admin-tool')
    })
  })

  describe('multi-source auth', () => {
    it('sources are tried in order and the first successful one grants access', async () => {
      const multi = multiAuth(
        staticTokenVerifier({ 'token-a': { scopes: ['read'] } }),
        staticTokenVerifier({ 'token-b': { scopes: ['write'] } }),
      )

      const resultA = await multi.verify('token-a')
      expect(resultA.scopes).toEqual(['read'])

      const resultB = await multi.verify('token-b')
      expect(resultB.scopes).toEqual(['write'])
    })

    it('access is denied only when all sources reject the request', async () => {
      const multi = multiAuth(
        staticTokenVerifier({ 'token-a': { scopes: ['read'] } }),
        staticTokenVerifier({ 'token-b': { scopes: ['write'] } }),
      )

      await expect(multi.verify('unknown-token')).rejects.toThrow()
    })
  })
})
