import { describe, it, expect, afterEach } from 'vitest'
import { discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/client'
import {
  FastMCP,
  remoteAuth,
  staticTokenVerifier,
  debugTokenVerifier,
  oauthProvider,
} from 'fastmcp-ts/server'
import type { FastMCPOptions, RemoteAuthOptions, TokenVerifier } from 'fastmcp-ts/server'
import { connectHttpClient, rawPost } from '../helpers/http'
import {
  getProtectedResource,
  resolveResourceUrl,
  protectedResourceRoute,
  bearerChallenge,
} from '../../src/server/auth/remote'

describe('remoteAuth()', () => {
  const base = { authorizationServers: ['https://auth.example.com'], baseUrl: 'https://mcp.example.com' }

  it('wraps a TokenVerifier as a TokenVerifier only', async () => {
    const auth = remoteAuth({ ...base, verifier: staticTokenVerifier({ good: { scopes: [] } }) })
    expect('verify' in auth).toBe(true)
    expect('verifyRequest' in auth).toBe(false)
    await expect(auth.verify('good')).resolves.toMatchObject({ token: 'good' })
  })

  it('wraps a RequestVerifier as a RequestVerifier only', () => {
    const auth = remoteAuth({
      ...base,
      verifier: { verifyRequest: async () => ({ token: 'u', scopes: [], claims: {} }) },
    })
    expect('verifyRequest' in auth).toBe(true)
    expect('verify' in auth).toBe(false)
  })

  it('preserves authorization server strings verbatim', () => {
    const auth = remoteAuth({
      ...base,
      verifier: debugTokenVerifier(),
      authorizationServers: ['https://auth.example.com', new URL('https://idp.example.com/realms/x')],
    })
    expect(auth.protectedResource.authorizationServers).toEqual([
      'https://auth.example.com',
      'https://idp.example.com/realms/x',
    ])
  })

  it.each([
    [{ baseUrl: 'not a url' }, /baseUrl/],
    [{ baseUrl: 'ftp://mcp.example.com' }, /baseUrl/],
    [{ baseUrl: 'https://mcp.example.com/?x=1' }, /baseUrl/],
    [{ authorizationServers: [] }, /authorizationServers/],
    [{ authorizationServers: ['nope'] }, /authorizationServers/],
    [{ scopesSupported: ['has space'] }, /scopesSupported/],
    [{ scopesSupported: ['quo"te'] }, /scopesSupported/],
  ])('rejects invalid options %o', (override, message) => {
    expect(() => remoteAuth({ ...base, verifier: debugTokenVerifier(), ...override })).toThrow(message)
  })

  it.each([
    ['https://mcp.example.com', '/mcp', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/', '/mcp', 'https://mcp.example.com/mcp'],
    ['https://example.com/api/', '/mcp', 'https://example.com/api/mcp'],
    ['https://mcp.example.com', '/', 'https://mcp.example.com/'],
  ])('resolveResourceUrl(%s, %s) is %s', (b, p, expected) => {
    expect(resolveResourceUrl(new URL(b), p).href).toBe(expected)
  })

  it('builds the route and document for a non-root MCP path', () => {
    const auth = remoteAuth({
      ...base,
      verifier: debugTokenVerifier(),
      scopesSupported: ['mcp:read'],
      resourceName: 'Example',
      resourceDocumentation: 'https://docs.example.com/mcp',
    })
    expect(protectedResourceRoute(auth.protectedResource, '/mcp')).toEqual({
      path: '/.well-known/oauth-protected-resource/mcp',
      metadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
      metadata: {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['mcp:read'],
        bearer_methods_supported: ['header'],
        resource_name: 'Example',
        resource_documentation: 'https://docs.example.com/mcp',
      },
    })
  })

  it('builds the challenge header', () => {
    const url = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
    expect(bearerChallenge({ resourceMetadataUrl: url })).toBe(
      `Bearer realm="mcp", resource_metadata="${url}"`,
    )
    expect(bearerChallenge({ resourceMetadataUrl: url, scopes: ['a', 'b'] }, 'invalid_token')).toBe(
      `Bearer realm="mcp", error="invalid_token", scope="a b", resource_metadata="${url}"`,
    )
  })

  it('getProtectedResource finds the config only on remoteAuth results', () => {
    const auth = remoteAuth({ ...base, verifier: debugTokenVerifier() })
    expect(getProtectedResource(auth)).toBe(auth.protectedResource)
    expect(getProtectedResource(debugTokenVerifier())).toBeUndefined()
    expect(getProtectedResource(undefined)).toBeUndefined()
  })
})

describe('remoteAuth over HTTP', () => {
  const META = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
  const options: RemoteAuthOptions<TokenVerifier> = {
    verifier: staticTokenVerifier({ good: { scopes: ['mcp:read'] } }),
    authorizationServers: ['https://auth.example.com'],
    baseUrl: 'https://mcp.example.com',
    scopesSupported: ['mcp:read'],
  }

  const servers: FastMCP[] = []
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()))
    servers.length = 0
  })

  async function start(
    extra: Partial<FastMCPOptions> = {},
    runPath?: string,
  ): Promise<{ mcp: FastMCP; local: string }> {
    const mcp = new FastMCP({ name: 'remote-auth-test', auth: remoteAuth(options), ...extra })
    servers.push(mcp)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', ...(runPath && { path: runPath }) })
    return { mcp, local: `http://127.0.0.1:${mcp.address!.port}` }
  }

  it('serves the document at the path-scoped well-known URL without auth', async () => {
    const { local } = await start()
    const res = await fetch(`${local}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['mcp:read'],
      bearer_methods_supported: ['header'],
    })
  })

  it('does not serve the root variant', async () => {
    const { local } = await start()
    expect((await fetch(`${local}/.well-known/oauth-protected-resource`)).status).toBe(404)
  })

  it('the SDK client discovers the document from the MCP URL', async () => {
    const { local } = await start()
    const meta = await discoverOAuthProtectedResourceMetadata(new URL(`${local}/mcp`))
    expect(meta.authorization_servers).toEqual(['https://auth.example.com'])
  })

  it('missing token: 401 challenge with scope and resource_metadata, no error', async () => {
    const { local } = await start()
    const res = await rawPost(new URL(`${local}/mcp`))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer realm="mcp", scope="mcp:read", resource_metadata="${META}"`,
    )
  })

  it('invalid token: 401 challenge with error="invalid_token"', async () => {
    const { local } = await start()
    const res = await rawPost(new URL(`${local}/mcp`), 'nope')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer realm="mcp", error="invalid_token", scope="mcp:read", resource_metadata="${META}"`,
    )
  })

  it('valid token still reaches the MCP endpoint', async () => {
    const { local } = await start()
    const { client, close } = await connectHttpClient(new URL(`${local}/mcp`), 'good')
    await expect(client.listTools()).resolves.toBeDefined()
    await close()
  })

  it('RequestVerifier 401 carries the challenge', async () => {
    const mcp = new FastMCP({
      name: 'remote-auth-test',
      auth: remoteAuth({
        verifier: {
          verifyRequest: async () => {
            throw new Error('no identity')
          },
        },
        authorizationServers: ['https://auth.example.com'],
        baseUrl: 'https://mcp.example.com',
      }),
    })
    servers.push(mcp)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const res = await rawPost(new URL(`http://127.0.0.1:${mcp.address!.port}/mcp`))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer realm="mcp", resource_metadata="${META}"`)
  })

  it('follows a custom run path and a baseUrl prefix', async () => {
    const mcp = new FastMCP({
      name: 'remote-auth-test',
      auth: remoteAuth({ ...options, baseUrl: 'https://example.com/api/' }),
    })
    servers.push(mcp)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', path: '/v1/mcp' })
    const res = await fetch(
      `http://127.0.0.1:${mcp.address!.port}/.well-known/oauth-protected-resource/api/v1/mcp`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ resource: 'https://example.com/api/v1/mcp' })
  })

  it('sends CORS headers per http.cors', async () => {
    const headers = { Origin: 'http://localhost:3000' }
    const withCors = await start()
    const allowed = await fetch(`${withCors.local}/.well-known/oauth-protected-resource/mcp`, { headers })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('*')

    const withoutCors = await start({ http: { cors: false } })
    const denied = await fetch(`${withoutCors.local}/.well-known/oauth-protected-resource/mcp`, { headers })
    expect(denied.status).toBe(200)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('fails loudly when a custom route already owns the metadata path', async () => {
    const mcp = new FastMCP({ name: 'remote-auth-test', auth: remoteAuth(options) })
    servers.push(mcp)
    mcp.customRoute({ path: '/.well-known/oauth-protected-resource/mcp' }, () => new Response('x'))
    await expect(mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })).rejects.toThrow(
      'customRoute already registered for path /.well-known/oauth-protected-resource/mcp',
    )
  })

  it('serves the document again after close() and a second run()', async () => {
    const { mcp } = await start()
    await mcp.close()
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const res = await fetch(`http://127.0.0.1:${mcp.address!.port}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
  })

  it('oauth takes precedence: no remote metadata route', async () => {
    const { local } = await start({ oauth: { provider: oauthProvider() } })
    const scoped = await fetch(`${local}/.well-known/oauth-protected-resource/mcp`)
    expect(scoped.status).toBe(200)
    const { authorization_servers } = (await scoped.json()) as { authorization_servers: string[] }
    expect(authorization_servers).not.toContain('https://auth.example.com')
    expect(authorization_servers).toEqual([`${local}/`])
    expect((await fetch(`${local}/.well-known/oauth-protected-resource`)).status).toBe(404)
  })
})
