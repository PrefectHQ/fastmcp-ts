import { describe, it, expect } from 'vitest'
import { remoteAuth, staticTokenVerifier, debugTokenVerifier } from 'fastmcp-ts/server'
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
