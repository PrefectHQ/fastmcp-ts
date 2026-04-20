import { McpError, ErrorCode, CancelledNotificationSchema } from '@modelcontextprotocol/sdk/types'
import type { Server } from '@modelcontextprotocol/sdk/server'
import type { McpContext } from './context'

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface MiddlewareContext<T = unknown> {
  readonly method: string
  readonly request: T
  readonly mcpContext: McpContext
}

export type Next<R = unknown> = () => Promise<R>

export interface Middleware {
  /** Called once per Server instance. Use to register notification handlers or other server-level setup. */
  setup?(server: Server): void

  // Coarse hook — fires for every request that has no more-specific hook on this instance
  onRequest?<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R>

  // Per-method hooks — take precedence over onRequest for their specific method
  onCallTool?<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R>
  onListTools?<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R>
  onReadResource?<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R>
  onListResources?<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R>
  onGetPrompt?<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R>
  onListPrompts?<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R>
}

// ---------------------------------------------------------------------------
// Chain execution
// ---------------------------------------------------------------------------

const METHOD_HOOK_KEY: Partial<Record<string, keyof Middleware>> = {
  'tools/call': 'onCallTool',
  'tools/list': 'onListTools',
  'resources/read': 'onReadResource',
  'resources/list': 'onListResources',
  'prompts/get': 'onGetPrompt',
  'prompts/list': 'onListPrompts',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHookFn = (ctx: MiddlewareContext<any>, next: Next<any>) => Promise<any>

function selectHook(mw: Middleware, method: string): AnyHookFn | null {
  const key = METHOD_HOOK_KEY[method]
  const specific = key ? (mw[key] as AnyHookFn | undefined) : undefined
  if (specific) return specific.bind(mw)
  if (mw.onRequest) return (mw.onRequest as AnyHookFn).bind(mw)
  return null
}

/** Build and execute the middleware chain, calling `handler` at the innermost level. */
export function runMiddlewareChain<R>(
  middleware: Middleware[],
  method: string,
  request: unknown,
  mcpContext: McpContext,
  handler: () => Promise<R>,
): Promise<R> {
  const hooks: AnyHookFn[] = []
  for (const mw of middleware) {
    const hook = selectHook(mw, method)
    if (hook) hooks.push(hook)
  }

  const ctx: MiddlewareContext = { method, request, mcpContext }

  function dispatch(i: number): Promise<R> {
    if (i >= hooks.length) return handler()
    return hooks[i](ctx, () => dispatch(i + 1))
  }

  return dispatch(0)
}

// ---------------------------------------------------------------------------
// Built-in middleware
// ---------------------------------------------------------------------------

/** Logs every request with method, outcome, and elapsed time. */
export class LoggingMiddleware implements Middleware {
  constructor(private readonly emit: (msg: string) => void = console.log) {}

  async onRequest<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R> {
    const t0 = Date.now()
    this.emit(`[fastmcp] → ${ctx.method}`)
    try {
      const result = await next()
      this.emit(`[fastmcp] ← ${ctx.method} (${Date.now() - t0}ms)`)
      return result
    } catch (err) {
      this.emit(
        `[fastmcp] ✗ ${ctx.method} (${Date.now() - t0}ms): ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  }
}

/** TTL-based response cache keyed on method + serialised request params. */
export class CachingMiddleware implements Middleware {
  private readonly _cache = new Map<string, { value: unknown; expiresAt: number }>()

  constructor(readonly ttl: number = 60_000) {}

  async onRequest<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R> {
    const key = `${ctx.method}:${JSON.stringify(ctx.request)}`
    const entry = this._cache.get(key)
    if (entry && entry.expiresAt > Date.now()) return entry.value as R
    const result = await next()
    this._cache.set(key, { value: result, expiresAt: Date.now() + this.ttl })
    return result
  }
}

/** Token-bucket rate limiter. Resets to full after every windowMs. */
export class RateLimitingMiddleware implements Middleware {
  private _tokens: number
  private _lastRefill: number

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
  ) {
    this._tokens = limit
    this._lastRefill = Date.now()
  }

  async onRequest<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R> {
    const now = Date.now()
    if (now - this._lastRefill >= this.windowMs) {
      this._tokens = this.limit
      this._lastRefill = now
    }
    if (this._tokens <= 0) {
      throw new McpError(ErrorCode.InvalidRequest, 'Rate limit exceeded')
    }
    this._tokens--
    return next()
  }
}

/** Rejects responses whose JSON serialisation exceeds maxBytes. */
export class SizeLimitingMiddleware implements Middleware {
  constructor(private readonly maxBytes: number) {}

  async onRequest<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R> {
    const result = await next()
    const size = Buffer.byteLength(JSON.stringify(result), 'utf8')
    if (size > this.maxBytes) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Response size (${size} bytes) exceeds limit (${this.maxBytes} bytes)`,
      )
    }
    return result
  }
}

/**
 * Normalises errors thrown by handlers to proper MCP shapes:
 * - tools/call errors  → { isError: true, content: [...] }  (per MCP spec)
 * - all other methods  → McpError(InternalError, message)
 */
export class ErrorNormalizationMiddleware implements Middleware {
  async onCallTool<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R> {
    try {
      return await next()
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      } as unknown as R
    }
  }

  async onRequest<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R> {
    try {
      return await next()
    } catch (err) {
      if (err instanceof McpError) throw err
      throw new McpError(
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

/**
 * Intercepts `notifications/cancelled` from the client and aborts the matching
 * in-flight handler via Promise.race + AbortController.
 */
export class CancellationMiddleware implements Middleware {
  private readonly _inFlight = new Map<string, AbortController>()

  setup(server: Server): void {
    server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      const requestId = String(notification.params.requestId)
      this._inFlight.get(requestId)?.abort()
    })
  }

  async onRequest<T, R>(ctx: MiddlewareContext<T>, next: Next<R>): Promise<R> {
    const { requestId } = ctx.mcpContext
    if (!requestId) return next()

    const controller = new AbortController()
    this._inFlight.set(requestId, controller)

    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new McpError(ErrorCode.InvalidRequest, 'Request cancelled')),
      )
    })

    try {
      return await Promise.race([next(), abortPromise])
    } finally {
      this._inFlight.delete(requestId)
    }
  }
}
