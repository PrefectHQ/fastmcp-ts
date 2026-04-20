import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp'
import {
  FastMCP,
  jwtVerifier,
  introspectionVerifier,
  staticTokenVerifier,
  debugTokenVerifier,
} from 'fastmcp-ts/server'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spin up a local JWKS server backed by a freshly generated RSA key pair. */
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

/** Minimal FastMCP HTTP server. Returns the running instance and its URL base. */
async function startServer(mcp: FastMCP) {
  await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
  const { port, path } = mcp.address!
  return { url: new URL(`http://127.0.0.1:${port}${path}`) }
}

/** Make a raw POST to the MCP endpoint with a given Authorization header (or none). */
async function rawPost(url: URL, bearer?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    }),
  })
}

/** Connect a full MCP client to the server with an optional bearer token. */
async function connectClient(url: URL, bearer?: string) {
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
  })
  await client.connect(transport)
  return { client, close: () => client.close() }
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
      const { close } = await connectClient(url, token)
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

    it.todo('claims from the validated token are available to tools via context')
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
      const introspectionPort = (introspectionServer.address() as AddressInfo).port
      cleanup.push(
        () => new Promise<void>((r, j) => introspectionServer.close((e) => (e ? j(e) : r()))),
      )

      const verifier = introspectionVerifier({
        endpoint: `http://127.0.0.1:${introspectionPort}/introspect`,
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
      const introspectionPort = (introspectionServer.address() as AddressInfo).port
      cleanup.push(
        () => new Promise<void>((r, j) => introspectionServer.close((e) => (e ? j(e) : r()))),
      )

      const verifier = introspectionVerifier({
        endpoint: `http://127.0.0.1:${introspectionPort}/introspect`,
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
      const introspectionPort = (introspectionServer.address() as AddressInfo).port
      cleanup.push(
        () => new Promise<void>((r, j) => introspectionServer.close((e) => (e ? j(e) : r()))),
      )

      const verifier = introspectionVerifier({
        endpoint: `http://127.0.0.1:${introspectionPort}/introspect`,
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
    it.todo('a client without credentials can register dynamically and obtain tokens')
    it.todo('registered clients authenticate successfully on subsequent requests')
  })

  describe('OAuth proxy', () => {
    it.todo('the proxy presents a DCR-compliant interface to MCP clients')
    it.todo('the proxy uses pre-registered credentials when talking to the upstream provider')
  })

  describe('scope-based authorization', () => {
    it.todo('requireScopes() grants access when the token carries all required scopes')
    it.todo('requireScopes() denies access when the token is missing a required scope')
    it.todo('multiple scopes passed to requireScopes() use AND logic — all must be present')
  })

  describe('per-component authorization', () => {
    it.todo('a tool registered with an auth check is blocked when the check fails')
    it.todo('a resource registered with an auth check is blocked when the check fails')
    it.todo('an unauthorized component does not appear in list results')
  })

  describe('multi-source auth', () => {
    it.todo('sources are tried in order and the first successful one grants access')
    it.todo('access is denied only when all sources reject the request')
  })
})
