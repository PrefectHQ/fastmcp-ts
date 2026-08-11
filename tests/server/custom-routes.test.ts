import { describe, it, expect, afterEach, vi } from 'vitest'
import { CustomRouteRegistry, resolveHealth, serveCustomRouteNode } from '../../src/server/customRoutes.js'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import http from 'node:http'
import { FastMCP, staticTokenVerifier, oauthProvider } from 'fastmcp-ts/server'

// ---------------------------------------------------------------------------
// Custom HTTP routes (issue #75): registry validation, matching, and health
// option resolution. HTTP integration tests live further down in this file
// (added with the FastMCP wiring); this section is pure unit coverage.
// ---------------------------------------------------------------------------

describe('CustomRouteRegistry', () => {
  it('registers a route and matches exact path + method (case-insensitive)', () => {
    const registry = new CustomRouteRegistry()
    const handler = () => new Response('ok')
    registry.register({ path: '/livez' }, handler)

    expect(registry.match('/livez', 'GET')).toEqual({ kind: 'handler', handler })
    expect(registry.match('/livez', 'get')).toEqual({ kind: 'handler', handler })
    expect(registry.match('/livez/', 'GET')).toBeNull()
    expect(registry.match('/other', 'GET')).toBeNull()
  })

  it('defaults methods to GET only and answers other methods with a mismatch', () => {
    const registry = new CustomRouteRegistry()
    registry.register({ path: '/livez' }, () => new Response('ok'))

    expect(registry.match('/livez', 'POST')).toEqual({ kind: 'method-mismatch', allow: 'GET' })
  })

  it('honors an explicit methods list and joins Allow from it', () => {
    const registry = new CustomRouteRegistry()
    registry.register({ path: '/hook', methods: ['post', 'PUT'] }, () => new Response('ok'))

    expect(registry.match('/hook', 'POST')?.kind).toBe('handler')
    expect(registry.match('/hook', 'PUT')?.kind).toBe('handler')
    expect(registry.match('/hook', 'GET')).toEqual({ kind: 'method-mismatch', allow: 'POST, PUT' })
  })

  it('never matches OPTIONS: the global CORS preflight owns it', () => {
    const registry = new CustomRouteRegistry()
    registry.register({ path: '/livez' }, () => new Response('ok'))

    expect(registry.match('/livez', 'OPTIONS')).toBeNull()
  })

  it('rejects OPTIONS in the methods list at registration (it would be unreachable)', () => {
    const registry = new CustomRouteRegistry()
    expect(() => registry.register({ path: '/x', methods: ['OPTIONS'] }, () => new Response(''))).toThrow(
      /OPTIONS/,
    )
  })

  it('rejects a duplicate path at registration', () => {
    const registry = new CustomRouteRegistry()
    registry.register({ path: '/livez' }, () => new Response('a'))
    expect(() => registry.register({ path: '/livez' }, () => new Response('b'))).toThrow(/already registered/)
  })

  it('rejects a path that is not a string starting with "/"', () => {
    const registry = new CustomRouteRegistry()
    expect(() => registry.register({ path: 'livez' }, () => new Response(''))).toThrow(/must .* start/i)
    expect(() =>
      registry.register({ path: 42 as unknown as string }, () => new Response('')),
    ).toThrow(/must .* start/i)
  })

  it('rejects an empty methods list', () => {
    const registry = new CustomRouteRegistry()
    expect(() => registry.register({ path: '/x', methods: [] }, () => new Response(''))).toThrow(/methods/)
  })

  it('assertNoMcpCollision throws when a route sits on the MCP path', () => {
    const registry = new CustomRouteRegistry()
    registry.register({ path: '/mcp' }, () => new Response('ok'))
    expect(() => registry.assertNoMcpCollision('/mcp')).toThrow(/collides/)
    expect(() => registry.assertNoMcpCollision('/other')).not.toThrow()
  })

  it('exposes registered paths and size', () => {
    const registry = new CustomRouteRegistry()
    registry.register({ path: '/a' }, () => new Response(''))
    registry.register({ path: '/b' }, () => new Response(''))
    expect(registry.paths().sort()).toEqual(['/a', '/b'])
    expect(registry.size).toBe(2)
  })
})

describe('resolveHealth', () => {
  it('returns null when omitted or explicitly off', () => {
    expect(resolveHealth(undefined)).toBeNull()
    expect(resolveHealth(false)).toBeNull()
    expect(resolveHealth({ enabled: false })).toBeNull()
    // enabled: false wins over other keys being present
    expect(resolveHealth({ enabled: false, path: '/x' })).toBeNull()
  })

  it('health: true and health: {} both mean all defaults', () => {
    const expected = { path: '/healthz', status: 200, body: 'ok' }
    expect(resolveHealth(true)).toEqual(expected)
    expect(resolveHealth({})).toEqual(expected)
    expect(resolveHealth({ enabled: true })).toEqual(expected)
  })

  it('applies overrides for path, status, and body', () => {
    expect(resolveHealth({ path: '/livez', status: 204, body: '' })).toEqual({
      path: '/livez',
      status: 204,
      body: '',
    })
  })

  it('throws on malformed values (JS callers get loud failures)', () => {
    expect(() => resolveHealth('yes' as unknown as boolean)).toThrow(/health/)
    expect(() => resolveHealth({ path: 'healthz' })).toThrow(/path/)
    expect(() => resolveHealth({ status: 99 })).toThrow(/status/)
    expect(() => resolveHealth({ status: 3.14 })).toThrow(/status/)
    expect(() => resolveHealth({ body: 42 as unknown as string })).toThrow(/body/)
  })

  it('throws when a non-empty body is combined with a null-body status', () => {
    // 101, 204, 205, 304 forbid any response body per the fetch spec; new Response
    // throws for those unless the body is empty. resolveHealth must catch it at
    // startup instead of letting every request 500.
    expect(resolveHealth({ status: 204, body: '' })).toEqual({ path: '/healthz', status: 204, body: '' })
    expect(() => resolveHealth({ status: 204 })).toThrow(/204/) // default body 'ok' is non-empty
    expect(() => resolveHealth({ status: 304, body: 'x' })).toThrow(/304/)
  })
})

describe('serveCustomRouteNode', () => {
  it('streams a successful response body to the client', async () => {
    const server = createServer(async (req, res) => {
      const handler = () => new Response('Hello, World!')
      await serveCustomRouteNode(handler, req, res)
    })

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port))
    })

    try {
      const response = await fetch(`http://localhost:${port}/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('Hello, World!')
    } finally {
      server.close()
    }
  })

  it('handles streaming response body errors without crashing the server', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const server = createServer(async (req, res) => {
      if (req.url === '/error-stream') {
        const handler = () => {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('partial'))
              },
              pull() {
                throw new Error('stream kaput')
              },
            }),
          )
        }
        await serveCustomRouteNode(handler, req, res)
      } else {
        // healthy handler for follow-up request
        const handler = () => new Response('ok')
        await serveCustomRouteNode(handler, req, res)
      }
    })

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port))
    })

    try {
      // Request the error-streaming endpoint
      const errorResponse = await fetch(`http://localhost:${port}/error-stream`)
      expect(errorResponse.status).toBe(200) // head already written before body error
      // Body read will fail but server survives

      // Follow-up request to a healthy handler must still work
      const healthyResponse = await fetch(`http://localhost:${port}/healthy`)
      expect(healthyResponse.status).toBe(200)
      expect(await healthyResponse.text()).toBe('ok')

      // Verify error was logged
      expect(errorLog).toHaveBeenCalledWith(
        '[fastmcp] custom route response stream failed:',
        expect.any(Error),
      )
    } finally {
      errorLog.mockRestore()
      server.close()
    }
  })
})

/** Raw GET with full header control (fetch forbids overriding Host). */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('customRoute() over the simple HTTP path', () => {
  let mcp: FastMCP | null = null
  afterEach(async () => {
    await mcp?.close()
    mcp = null
  })

  it('serves a matched route with the handler-authored status, headers, and body', async () => {
    mcp = new FastMCP({ name: 'routes' })
    mcp.customRoute({ path: '/livez' }, () => new Response('alive', { status: 200, headers: { 'X-Custom': 'yes' } }))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-custom')).toBe('yes')
    expect(await res.text()).toBe('alive')
  })

  it('serves the route without a bearer token while MCP auth is configured', async () => {
    mcp = new FastMCP({
      name: 'routes',
      auth: staticTokenVerifier({ 'valid-token': { scopes: ['read'] } }),
    })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!

    // The MCP path itself still requires auth.
    const mcpRes = await fetch(`http://127.0.0.1:${port}${path}`)
    expect(mcpRes.status).toBe(401)

    const routeRes = await fetch(`http://127.0.0.1:${port}/livez`)
    expect(routeRes.status).toBe(200)
  })

  it('serves the route despite a foreign Host header (kubelet probes send the pod IP)', async () => {
    // Loopback bind auto-enables the DNS-rebinding Host guard; the route must bypass it.
    mcp = new FastMCP({ name: 'routes' })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!

    const evil = await rawGet(port, '/livez', { Host: '10.0.0.7:8080' })
    expect(evil.status).toBe(200)
    expect(evil.body).toBe('ok')

    // Sanity: the guard still protects the MCP path on the same server.
    const guarded = await rawGet(port, path, { Host: 'evil.example.com' })
    expect(guarded.status).toBe(403)
  })

  it('answers 405 with an Allow header on a method mismatch', async () => {
    mcp = new FastMCP({ name: 'routes' })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez`, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
  })

  it('serves a matched route when the request carries a query string', async () => {
    mcp = new FastMCP({ name: 'routes' })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez?probe=1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('answers 405 with an Allow header for a method outside the declared list, even HEAD', async () => {
    // methods is exact by design: HEAD is not synthesized from a GET-only route.
    mcp = new FastMCP({ name: 'routes' })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez`, { method: 'HEAD' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
  })

  it('OPTIONS on a route path still gets the global CORS preflight', async () => {
    mcp = new FastMCP({ name: 'routes' })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('a throwing handler answers 500 JSON and logs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mcp = new FastMCP({ name: 'routes' })
      mcp.customRoute({ path: '/boom' }, () => {
        throw new Error('kaput')
      })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      const { port } = mcp.address!

      const res = await fetch(`http://127.0.0.1:${port}/boom`)
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Internal Server Error' })
      expect(errorSpy).toHaveBeenCalledWith('[fastmcp] custom route handler failed:', expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a route on the MCP path aborts startup', async () => {
    mcp = new FastMCP({ name: 'routes' })
    mcp.customRoute({ path: '/mcp' }, () => new Response('ok'))
    await expect(mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })).rejects.toThrow(/collides/)
  })

  it('unmatched paths still 404 and MCP traffic still serves', async () => {
    mcp = new FastMCP({ name: 'routes' })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!

    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404)
    // The MCP endpoint is reachable (405/4xx from a bare GET is fine; not 404).
    expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).not.toBe(404)
  })
})

describe('customRoute() over the OAuth (express) path', () => {
  let mcp: FastMCP | null = null
  afterEach(async () => {
    await mcp?.close()
    mcp = null
  })

  it('serves the route with no token while the MCP path requires OAuth', async () => {
    mcp = new FastMCP({ name: 'routes', oauth: { provider: oauthProvider() } })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!

    const routeRes = await fetch(`http://127.0.0.1:${port}/livez`)
    expect(routeRes.status).toBe(200)
    expect(await routeRes.text()).toBe('ok')

    const mcpRes = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
    expect(mcpRes.status).toBe(401)
  })

  it('answers 405 with Allow on a method mismatch', async () => {
    mcp = new FastMCP({ name: 'routes', oauth: { provider: oauthProvider() } })
    mcp.customRoute({ path: '/livez' }, () => new Response('ok'))
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez`, { method: 'DELETE' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
  })

  it('OPTIONS on a route path never invokes the handler and falls through to the express default 404', async () => {
    const handler = vi.fn(() => new Response('ok'))
    mcp = new FastMCP({ name: 'routes', oauth: { provider: oauthProvider() } })
    mcp.customRoute({ path: '/livez' }, handler)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez`, { method: 'OPTIONS' })
    expect(res.status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })

  it('matching is exact-path, case-sensitive, and does not treat the request path as a pattern', async () => {
    // Regression: app.all(routePath, ...) fed paths into express's path-to-regexp,
    // which is case-insensitive and non-strict on trailing slashes. A registry-driven
    // exact match must reject both instead of serving the route registered at /livez.
    const handler = vi.fn(() => new Response('ok'))
    mcp = new FastMCP({ name: 'routes', oauth: { provider: oauthProvider() } })
    mcp.customRoute({ path: '/livez' }, handler)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    expect((await fetch(`http://127.0.0.1:${port}/LIVEZ`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/livez/`)).status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })
})
