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

      mcp.tool({ name: 'whoami' }, () => {
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
      mcp.tool({ name: 'ping' }, () => 'pong')
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
      mcp.tool({ name: 'ping' }, () => 'pong')
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
      mcp.tool({ name: 'admin-tool', auth: requireScopes('admin') }, () => 'secret data')
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
      mcp.tool({ name: 'public-tool' }, () => 'public')
      mcp.tool({ name: 'admin-tool', auth: requireScopes('admin') }, () => 'secret')
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
