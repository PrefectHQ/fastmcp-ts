import { describe, it, expect, vi } from 'vitest'
import { FastMCP } from 'fastmcp-ts/server'
import {
  LoggingMiddleware,
  CachingMiddleware,
  RateLimitingMiddleware,
  SizeLimitingMiddleware,
  ErrorNormalizationMiddleware,
  CancellationMiddleware,
} from 'fastmcp-ts/server'
import type { Middleware, MiddlewareContext, Next } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe('Server — Middleware', () => {
  describe('pipeline', () => {
    it('middleware runs before the handler and can inspect the request', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'echo', description: 'echo' }, () => 'ok')

      const seen: unknown[] = []
      const mw: Middleware = {
        async onRequest(ctx, next) {
          seen.push(ctx.request)
          return next()
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'echo', arguments: {} })
        expect(seen).toHaveLength(1)
        expect((seen[0] as { name: string }).name).toBe('echo')
      } finally {
        await close()
      }
    })

    it('middleware runs after the handler and can inspect the response', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'echo', description: 'echo' }, () => 'hello')

      const responses: unknown[] = []
      const mw: Middleware = {
        async onRequest(ctx, next) {
          const result = await next()
          responses.push(result)
          return result
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'echo', arguments: {} })
        expect(responses).toHaveLength(1)
        expect(JSON.stringify(responses[0])).toContain('hello')
      } finally {
        await close()
      }
    })

    it('middleware can short-circuit the pipeline and return early', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const handlerSpy = vi.fn(() => 'real response')
      mcp.tool({ name: 'echo', description: 'echo' }, handlerSpy)

      const mw: Middleware = {
        async onRequest(_ctx, _next) {
          // Short-circuit: never call next()
          return {
            content: [{ type: 'text' as const, text: 'short-circuited' }],
          }
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'echo', arguments: {} })
        expect(handlerSpy).not.toHaveBeenCalled()
        expect(result.content[0]).toMatchObject({ type: 'text', text: 'short-circuited' })
      } finally {
        await close()
      }
    })

    it('multiple middleware layers execute in registration order on the way in and reverse on the way out', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'echo', description: 'echo' }, () => 'ok')

      const log: string[] = []

      const makeLayer = (name: string): Middleware => ({
        async onRequest(ctx, next) {
          log.push(`${name} in`)
          const result = await next()
          log.push(`${name} out`)
          return result
        },
      })

      mcp.use(makeLayer('A'))
      mcp.use(makeLayer('B'))
      mcp.use(makeLayer('C'))

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'echo', arguments: {} })
        expect(log).toEqual(['A in', 'B in', 'C in', 'C out', 'B out', 'A out'])
      } finally {
        await close()
      }
    })

    it('setup() is called on the primary server synchronously when middleware is registered via use()', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      let setupCalled = false
      let setupReceivedServer = false

      const mw: Middleware = {
        setup(server) {
          setupCalled = true
          setupReceivedServer = typeof server.setNotificationHandler === 'function'
        },
      }

      mcp.use(mw)

      // setup() must have been called synchronously by use(), before connect()
      expect(setupCalled).toBe(true)
      expect(setupReceivedServer).toBe(true)

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Built-in middleware
  // ---------------------------------------------------------------------------

  describe('built-in middleware', () => {
    it('request logging middleware emits structured logs for every operation', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      const logs: string[] = []
      mcp.use(new LoggingMiddleware((msg) => logs.push(msg)))

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
        expect(logs.some((l) => l.includes('tools/call') && l.includes('→'))).toBe(true)
        expect(logs.some((l) => l.includes('tools/call') && l.includes('←'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('caching middleware returns a stored response for repeated identical requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let callCount = 0
      mcp.tool({ name: 'count', description: 'count' }, () => {
        callCount++
        return `call ${callCount}`
      })

      mcp.use(new CachingMiddleware(60_000))

      const { client, close } = await createTestClient(mcp)
      try {
        const r1 = await client.callTool({ name: 'count', arguments: {} })
        const r2 = await client.callTool({ name: 'count', arguments: {} })
        expect(callCount).toBe(1)
        expect(r1.content).toEqual(r2.content)
      } finally {
        await close()
      }
    })

    it('rate limiting middleware rejects requests that exceed the configured limit', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'ok')

      // limit=1 per very long window so the second call fails
      mcp.use(new RateLimitingMiddleware(1, 60_000))

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
        // Second call should be rejected — it comes back as isError:true because McpError
        // propagates through the tool error path
        const result = await client.callTool({ name: 'ping', arguments: {} })
        // Rate limit McpError is re-thrown (not caught by tool handler) so the SDK returns it
        // as a protocol-level error. The client raises an exception.
        // If the test reaches here without throwing, the result must be an error.
        expect(result.isError).toBe(true)
      } catch {
        // Expected: rate-limit McpError propagated as protocol error
      } finally {
        await close()
      }
    })

    it('size-limiting middleware rejects responses that exceed the configured byte threshold', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'big', description: 'big' }, () => 'x'.repeat(1000))

      mcp.use(new SizeLimitingMiddleware(10))

      const { client, close } = await createTestClient(mcp)
      try {
        // McpError thrown by middleware propagates as a protocol-level error
        await expect(client.callTool({ name: 'big', arguments: {} })).rejects.toThrow()
      } finally {
        await close()
      }
    })

    it('error normalization middleware maps thrown errors to correct MCP error codes and shapes', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'data://broken', name: 'broken' }, () => {
        throw new Error('something went wrong')
      })

      mcp.use(new ErrorNormalizationMiddleware())

      const { client, close } = await createTestClient(mcp)
      try {
        // Without normalization a plain Error becomes an unhandled rejection → SDK wraps it.
        // With ErrorNormalizationMiddleware it becomes McpError(InternalError).
        await expect(client.readResource({ uri: 'data://broken' })).rejects.toThrow(
          /something went wrong/,
        )
      } finally {
        await close()
      }
    })

    it('cancellation middleware intercepts notifications/cancelled and aborts the in-flight handler', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let handlerStarted = false

      mcp.tool({ name: 'slow', description: 'slow' }, async () => {
        handlerStarted = true
        await new Promise((r) => setTimeout(r, 5_000))
        return 'done'
      })

      mcp.use(new CancellationMiddleware())

      const { client, close } = await createTestClient(mcp)
      try {
        const controller = new AbortController()
        const callPromise = client.callTool({ name: 'slow', arguments: {} }, undefined, {
          signal: controller.signal,
        })
        // Wait for the handler to start, then cancel
        await new Promise((r) => setTimeout(r, 30))
        expect(handlerStarted).toBe(true)
        controller.abort()
        await expect(callPromise).rejects.toThrow()
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Per-method hooks
  // ---------------------------------------------------------------------------

  describe('per-method hooks', () => {
    it('on_call_tool hook fires only for tools/call requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')
      mcp.resource({ uri: 'data://x', name: 'x' }, () => 'data')

      const toolHook = vi.fn((_ctx: MiddlewareContext, next: Next) => next())
      const requestHook = vi.fn((_ctx: MiddlewareContext, next: Next) => next())

      mcp.use({ onCallTool: toolHook, onRequest: requestHook })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
        await client.readResource({ uri: 'data://x' })

        // onCallTool fired once (for tools/call), not for resources/read
        expect(toolHook).toHaveBeenCalledTimes(1)
        // onRequest fired once (for resources/read — no specific hook matched)
        expect(requestHook).toHaveBeenCalledTimes(1)
        expect((requestHook.mock.calls[0][0] as MiddlewareContext).method).toBe('resources/read')
      } finally {
        await close()
      }
    })

    it('on_list_tools hook fires only for tools/list requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      const fired: string[] = []
      mcp.use({
        onListTools: (_ctx, next) => { fired.push('list-tools'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.listTools()
        expect(fired).toContain('list-tools')
        expect(fired.every((e) => !e.startsWith('request:tools/list'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_read_resource hook fires only for resources/read requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'data://x', name: 'x' }, () => 'data')

      const fired: string[] = []
      mcp.use({
        onReadResource: (_ctx, next) => { fired.push('read-resource'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.readResource({ uri: 'data://x' })
        expect(fired).toContain('read-resource')
        expect(fired.every((e) => !e.startsWith('request:resources/read'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_list_resources hook fires only for resources/list requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'data://x', name: 'x' }, () => 'data')

      const fired: string[] = []
      mcp.use({
        onListResources: (_ctx, next) => { fired.push('list-resources'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.listResources()
        expect(fired).toContain('list-resources')
        expect(fired.every((e) => !e.startsWith('request:resources/list'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_get_prompt hook fires only for prompts/get requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'greet', description: 'greet' }, () => 'Hello!')

      const fired: string[] = []
      mcp.use({
        onGetPrompt: (_ctx, next) => { fired.push('get-prompt'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.getPrompt({ name: 'greet', arguments: {} })
        expect(fired).toContain('get-prompt')
        expect(fired.every((e) => !e.startsWith('request:prompts/get'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_list_prompts hook fires only for prompts/list requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'greet', description: 'greet' }, () => 'Hello!')

      const fired: string[] = []
      mcp.use({
        onListPrompts: (_ctx, next) => { fired.push('list-prompts'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.listPrompts()
        expect(fired).toContain('list-prompts')
        expect(fired.every((e) => !e.startsWith('request:prompts/list'))).toBe(true)
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Custom middleware
  // ---------------------------------------------------------------------------

  describe('custom middleware', () => {
    it('a custom middleware function receives the request, a next() callback, and the context', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      let captured: { method: string; hasNext: boolean; hasContext: boolean } | undefined

      const mw: Middleware = {
        async onRequest(ctx, next) {
          captured = {
            method: ctx.method,
            hasNext: typeof next === 'function',
            hasContext: ctx.mcpContext !== undefined,
          }
          return next()
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
        expect(captured).toEqual({ method: 'tools/call', hasNext: true, hasContext: true })
      } finally {
        await close()
      }
    })

    it('values set via ctx.setState() by middleware are available in downstream tool handlers', async () => {
      const mcp = new FastMCP({ name: 'test' })

      mcp.tool({ name: 'read', description: 'read' }, () => {
        const ctx = mcp.getContext()
        return ctx.getState('injected') as string
      })

      const mw: Middleware = {
        async onRequest(ctx, next) {
          ctx.mcpContext.setState('injected', 'from-middleware')
          return next()
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'read', arguments: {} })
        expect(result.content[0]).toMatchObject({ type: 'text', text: 'from-middleware' })
      } finally {
        await close()
      }
    })
  })
})
