import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  AuthorizationError, FastMCP, introspectionVerifier, multiAuth,
  staticTokenVerifier, VerificationUnavailableError, remoteAuth,
} from 'fastmcp-ts/server'
import type { RequestVerifier, TokenVerifier } from 'fastmcp-ts/server'
import { connectHttpClient } from '../helpers/http'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
})

async function fixture(reply: (res: ServerResponse) => void) {
  let requests = 0
  const server = createServer((_req, res) => { requests++; reply(res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/introspect`,
    requests: () => requests,
  }
}

async function serve(auth: TokenVerifier | RequestVerifier) {
  const metadata = { baseUrl: 'https://mcp.example.com', authorizationServers: ['https://auth.example.com'] }
  const external = 'verifyRequest' in auth
    ? remoteAuth({ ...metadata, verifier: auth })
    : remoteAuth({ ...metadata, verifier: auth })
  const mcp = new FastMCP({ name: 'availability-test', auth: external })
  const executed = vi.fn(() => 'accepted')
  mcp.tool({ name: 'probe', description: 'Read a fixture value' }, executed)
  await mcp.run({ transport: 'http', host: '127.0.0.1', port: 0 })
  cleanup.push(() => mcp.close())
  return { url: `http://127.0.0.1:${mcp.address!.port}/mcp`, executed }
}

function post(url: string, version = '2025-06-18') {
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json', 'MCP-Protocol-Version': version },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'probe', arguments: {} } }),
  })
}

function verifier(endpoint: string, extra = {}) {
  return introspectionVerifier({ endpoint, credentials: { clientId: 'fixture', clientSecret: 'secret' }, ...extra })
}

describe('verification availability', () => {
  it.each([429, 503, 500, 502, 504, 401, 403, 400])('an upstream %i is not a caller credential verdict', async status => {
    const upstream = await fixture(res => res.writeHead(status, { 'Retry-After': '17' }).end('private upstream detail'))
    const { url, executed } = await serve(verifier(upstream.endpoint))
    const response = await post(url)
    expect(response.status).toBe(503)
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(response.headers.get('retry-after')).toBe('17')
    expect(response.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('retry-after')
    expect(await response.json()).toEqual({ error: 'Token verification is temporarily unavailable' })
    expect(executed).not.toHaveBeenCalled()
    expect(upstream.requests()).toBe(1)
  })

  it.each(['token', 'request'] as const)('both protocol eras preserve the typed %s verifier failure', async kind => {
    const fail = async () => { throw new VerificationUnavailableError({ cause: new Error('private secret'), retryAfter: '9' }) }
    const auth = kind === 'token' ? { verify: fail } : { verifyRequest: fail }
    const { url, executed } = await serve(auth)
    for (const version of ['2025-06-18', '2026-07-28']) {
      const response = await post(url, version)
      expect(response.status).toBe(503)
      expect(response.headers.get('www-authenticate')).toBeNull()
      expect(response.headers.get('retry-after')).toBe('9')
      expect(await response.text()).toBe(JSON.stringify({ error: 'Token verification is temporarily unavailable' }))
    }
    expect(executed).not.toHaveBeenCalled()
  })

  it('keeps inactive-token rejection at 401 without retry guidance', async () => {
    const upstream = await fixture(res => res.end(JSON.stringify({ active: false })))
    const { url } = await serve(verifier(upstream.endpoint))
    const response = await post(url)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer ')
    expect(response.headers.get('retry-after')).toBeNull()
    expect(await response.json()).toEqual({ error: 'Token is not active' })
  })

  it('keeps explicit authorization denial at 403', async () => {
    const { url } = await serve({ verify: async () => { throw new AuthorizationError('Scope denied') } })
    const response = await post(url)
    expect(response.status).toBe(403)
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(await response.json()).toEqual({ error: 'Scope denied' })
  })

  it.each(['not json', 'null', '[]', '{}', '{"active":"true"}', '{"active":true,"scope":42}', '{"active":true,"exp":"forever"}'])('malformed introspection %s cannot establish identity', async body => {
    const upstream = await fixture(res => res.end(body))
    const { url, executed } = await serve(verifier(upstream.endpoint))
    const response = await post(url)
    expect(response.status).toBe(503)
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(await response.json()).toEqual({ error: 'Token verification is temporarily unavailable' })
    expect(executed).not.toHaveBeenCalled()
  })

  it('maps connection failures to unavailable without exposing the cause', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('private connection detail'))
    await expect(verifier('http://127.0.0.1:1').verify('fixture-token')).rejects.toBeInstanceOf(VerificationUnavailableError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('bounds a response that never sends headers or finishes its body', async () => {
    for (const headers of [false, true]) {
      const upstream = await fixture(res => { if (headers) res.writeHead(200).write('{') })
      await expect(verifier(upstream.endpoint, { timeoutMs: 100 }).verify('fixture-token')).rejects.toBeInstanceOf(VerificationUnavailableError)
      expect(upstream.requests()).toBe(1)
    }
  })

  it('does not follow an introspection redirect or forward credentials', async () => {
    const target = await fixture(res => res.end(JSON.stringify({ active: true })))
    const redirect = await fixture(res => res.writeHead(302, { Location: target.endpoint }).end())
    await expect(verifier(redirect.endpoint).verify('fixture-token')).rejects.toBeInstanceOf(VerificationUnavailableError)
    expect(redirect.requests()).toBe(1)
    expect(target.requests()).toBe(0)
  })

  it('does not cache a failure or replay a tool after an outage', async () => {
    let available = false
    const upstream = await fixture(res => available
      ? res.end(JSON.stringify({ active: true, client_id: 'fixture-client', scope: 'read', sub: 'same-person' }))
      : res.writeHead(503).end())
    const { url, executed } = await serve(verifier(upstream.endpoint, { cacheTtl: 60 }))
    const failed = await post(url)
    expect(failed.status).toBe(503)
    await failed.body?.cancel()
    expect(executed).not.toHaveBeenCalled()
    expect(upstream.requests()).toBe(1)
    available = true
    const connection = await connectHttpClient(new URL(url), 'fixture-token')
    cleanup.push(connection.close)
    const result = await connection.client.callTool({ name: 'probe', arguments: {} })
    expect(result.content).toEqual([{ type: 'text', text: 'accepted' }])
    expect(executed).toHaveBeenCalledTimes(1)
    expect(upstream.requests()).toBe(2)
  })

  it.each([
    ['0', 0], ['12', 12], ['9999999999999999', 300], ['-1', undefined],
    ['1.5', undefined], ['garbage', undefined], ['1\r\nX-Secret: value', undefined],
  ])('bounds Retry-After %j without reflecting arbitrary values', (retryAfter, expected) => {
    expect(new VerificationUnavailableError({ retryAfter }).retryAfterSeconds).toBe(expected)
  })

  it('accepts HTTP-date retry guidance and limits it to five minutes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T16:00:00Z'))
    expect(new VerificationUnavailableError({ retryAfter: 'Wed, 04 Nov 2026 16:00:20 GMT' }).retryAfterSeconds).toBe(20)
    expect(new VerificationUnavailableError({ retryAfter: 'Wed, 04 Nov 2026 17:00:00 GMT' }).retryAfterSeconds).toBe(300)
  })

  it('multiAuth preserves unavailable only if no verifier accepts the credential', async () => {
    const unavailable = new VerificationUnavailableError({ retryAfter: '7' })
    const down = { verify: async () => { throw unavailable } }
    const local = staticTokenVerifier({ good: { scopes: ['read'] } })
    await expect(multiAuth(down, local).verify('good')).resolves.toMatchObject({ scopes: ['read'] })
    await expect(multiAuth(down, local).verify('bad')).rejects.toBe(unavailable)
    await expect(multiAuth(local, down).verify('bad')).rejects.toBe(unavailable)
    await expect(multiAuth(local).verify('bad')).rejects.not.toBeInstanceOf(VerificationUnavailableError)
  })
})
