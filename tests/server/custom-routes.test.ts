import { describe, it, expect, vi } from 'vitest'
import { CustomRouteRegistry, resolveHealth, serveCustomRouteNode } from '../../src/server/customRoutes.js'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
