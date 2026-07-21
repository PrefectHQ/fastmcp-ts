import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
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

/**
 * A middleware hook. Either call `next()` and return (optionally transforming) its
 * result, or short-circuit by returning your own result without calling `next()`.
 * The return is typed `Promise<unknown>` because a hook can substitute any result
 * shape for the method it intercepts; the framework resolves the concrete type at
 * the call boundary.
 */
export interface Middleware {
  /** Called once per Server instance. Use to register notification handlers or other server-level setup. */
  setup?(server: Server): void

  // Coarse hook — fires for every request that has no more-specific hook on this instance
  onRequest?(ctx: MiddlewareContext, next: Next): Promise<unknown>

  // Per-method hooks — take precedence over onRequest for their specific method
  onCallTool?(ctx: MiddlewareContext, next: Next): Promise<unknown>
  onListTools?(ctx: MiddlewareContext, next: Next): Promise<unknown>
  onReadResource?(ctx: MiddlewareContext, next: Next): Promise<unknown>
  onListResources?(ctx: MiddlewareContext, next: Next): Promise<unknown>
  onListResourceTemplates?(ctx: MiddlewareContext, next: Next): Promise<unknown>
  onGetPrompt?(ctx: MiddlewareContext, next: Next): Promise<unknown>
  onListPrompts?(ctx: MiddlewareContext, next: Next): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Chain execution
// ---------------------------------------------------------------------------

const METHOD_HOOK_KEY: Partial<Record<string, keyof Middleware>> = {
  'tools/call': 'onCallTool',
  'tools/list': 'onListTools',
  'resources/read': 'onReadResource',
  'resources/list': 'onListResources',
  'resources/templates/list': 'onListResourceTemplates',
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

  async onRequest(ctx: MiddlewareContext, next: Next): Promise<unknown> {
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

/**
 * Custom cache key function. Receives the full middleware context so callers can
 * incorporate auth identity or any other dimension into the key.
 *
 * **Required when using per-component auth checks.** The default key is
 * `"method:JSON(params)"`, which contains no auth information. If auth-filtered
 * list results (tools, resources, prompts) are cached with the default key, one
 * session's filtered results can be served to a session with different permissions.
 * Pass a `keyFn` that includes the caller identity, e.g.:
 *
 * ```ts
 * new CachingMiddleware(60_000, (ctx) =>
 *   `${ctx.method}:${ctx.mcpContext.auth?.clientId ?? ''}:${JSON.stringify(ctx.request)}`
 * )
 * ```
 */
export type CacheKeyFn = (ctx: MiddlewareContext) => string

/** TTL-based response cache keyed on method + serialised request params by default.
 *  Pass a custom `keyFn` when using per-component auth so cached results are
 *  partitioned by caller identity. */
export class CachingMiddleware implements Middleware {
  private readonly _cache = new Map<string, { value: unknown; expiresAt: number }>()

  constructor(
    readonly ttl: number = 60_000,
    private readonly _keyFn?: CacheKeyFn,
  ) {}

  async onRequest(ctx: MiddlewareContext, next: Next): Promise<unknown> {
    const key = this._keyFn
      ? this._keyFn(ctx as MiddlewareContext)
      : `${ctx.method}:${JSON.stringify(ctx.request)}`
    const entry = this._cache.get(key)
    if (entry && entry.expiresAt > Date.now()) return entry.value
    const result = await next()
    this._cache.set(key, { value: result, expiresAt: Date.now() + this.ttl })
    return result
  }
}

/** Fixed-window counter rate limiter. Resets to full capacity after every windowMs interval. */
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

  async onRequest(ctx: MiddlewareContext, next: Next): Promise<unknown> {
    const now = Date.now()
    if (now - this._lastRefill >= this.windowMs) {
      this._tokens = this.limit
      this._lastRefill = now
    }
    if (this._tokens <= 0) {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Rate limit exceeded')
    }
    this._tokens--
    return next()
  }
}

/** Rejects responses whose JSON serialisation exceeds maxBytes. */
export class SizeLimitingMiddleware implements Middleware {
  constructor(private readonly maxBytes: number) {}

  async onRequest(ctx: MiddlewareContext, next: Next): Promise<unknown> {
    const result = await next()
    const size = Buffer.byteLength(JSON.stringify(result), 'utf8')
    if (size > this.maxBytes) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Response size (${size} bytes) exceeds limit (${this.maxBytes} bytes)`,
      )
    }
    return result
  }
}

/**
 * Normalises errors thrown by handlers to proper MCP shapes:
 * - tools/call plain errors → { isError: true, content: [...] }  (per MCP spec)
 * - tools/call McpError     → re-thrown as a protocol-level error
 * - all other methods       → McpError(InternalError, message)
 *
 * Re-throwing McpError from onCallTool ensures that middleware-level errors
 * (e.g. from RateLimitingMiddleware or SizeLimitingMiddleware stacked before
 * this middleware) always propagate as protocol errors and are never silently
 * converted to isError:true tool responses.
 */
export class ErrorNormalizationMiddleware implements Middleware {
  async onCallTool(ctx: MiddlewareContext, next: Next): Promise<unknown> {
    try {
      return await next()
    } catch (err) {
      if (err instanceof ProtocolError) throw err
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      }
    }
  }

  async onRequest(ctx: MiddlewareContext, next: Next): Promise<unknown> {
    try {
      return await next()
    } catch (err) {
      if (err instanceof ProtocolError) throw err
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

/**
 * Intercepts `notifications/cancelled` from the client and aborts the matching
 * in-flight handler via Promise.race + AbortController.
 *
 * KNOWN GAP (2026-07-28): this only covers legacy (2025-era) and stdio cancellation.
 * On a modern Streamable HTTP connection, the SDK signals cancellation by closing the
 * request's response stream rather than sending `notifications/cancelled` — the client
 * is correctly told the call was cancelled either way, but a handler registered here
 * keeps running server-side to completion on the modern path, since this middleware
 * never observes that stream closure. The SDK exposes it per-request as
 * `ctx.mcpReq.signal` (a `BaseContext` field, present on every era) — unifying this
 * middleware with that signal (so long-running handlers actually stop executing on
 * both eras) is tracked as follow-up work, not yet implemented here.
 */
export class CancellationMiddleware implements Middleware {
  private readonly _inFlight = new Map<string, AbortController>()

  setup(server: Server): void {
    server.setNotificationHandler('notifications/cancelled', (notification) => {
      const requestId = String(notification.params.requestId)
      this._inFlight.get(requestId)?.abort()
    })
  }

  async onRequest(ctx: MiddlewareContext, next: Next): Promise<unknown> {
    const { requestId } = ctx.mcpContext
    if (!requestId) return next()

    const controller = new AbortController()
    this._inFlight.set(requestId, controller)

    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new ProtocolError(ProtocolErrorCode.InternalError, 'Request was cancelled by the client')),
      )
    })

    try {
      return await Promise.race([next(), abortPromise])
    } finally {
      this._inFlight.delete(requestId)
    }
  }
}
