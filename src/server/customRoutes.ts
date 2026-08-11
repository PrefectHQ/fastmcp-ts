import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

/**
 * Handler for a custom HTTP route served by the listener `run()` starts.
 * Owns the whole exchange: no MCP auth, no DNS-rebinding guards, and no CORS
 * headers run in front of it, and its Response is written back verbatim.
 */
export type CustomRouteHandler = (request: Request) => Response | Promise<Response>

export interface CustomRouteConfig {
  /** Exact request path to serve; the query string is ignored for matching.
   * Must start with `/`. No patterns, no path parameters. */
  path: string
  /**
   * HTTP methods served, compared case-insensitively. Default: `['GET']`.
   * `OPTIONS` is rejected at registration: the global CORS preflight answers
   * `OPTIONS` before route dispatch, so a route on it would be unreachable.
   */
  methods?: string[]
}

/** `RunOptions.health` object form. Presence implies enabled. */
export interface HealthOptions {
  /** Force off with `false`; the object's presence already implies `true`. */
  enabled?: boolean
  /** Request path of the endpoint. Default: `/healthz`. */
  path?: string
  /** Response status code. Default: `200`. */
  status?: number
  /** Response body, served as `text/plain`. Default: `'ok'`. */
  body?: string
}

export interface ResolvedHealth {
  path: string
  status: number
  body: string
}

export type RouteMatch =
  | { kind: 'handler'; handler: CustomRouteHandler }
  | { kind: 'method-mismatch'; allow: string }

interface RegisteredRoute {
  methods: Set<string>
  handler: CustomRouteHandler
}

/** Registry of custom routes for one FastMCP instance. Registration validates
 * loudly; matching is exact-path with the query string already stripped. */
export class CustomRouteRegistry {
  private _routes = new Map<string, RegisteredRoute>()

  register(config: CustomRouteConfig, handler: CustomRouteHandler): void {
    const path = config?.path
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error(`customRoute path must be a string starting with "/", got: ${JSON.stringify(path)}`)
    }
    const methods = (config.methods ?? ['GET']).map((m) => m.toUpperCase())
    if (methods.length === 0) {
      throw new Error(`customRoute ${path}: methods must not be empty (omit it for the GET default)`)
    }
    if (methods.includes('OPTIONS')) {
      throw new Error(
        `customRoute ${path}: OPTIONS cannot be routed — the CORS preflight handler answers OPTIONS before route dispatch`,
      )
    }
    if (this._routes.has(path)) {
      throw new Error(`customRoute already registered for path ${path}`)
    }
    this._routes.set(path, { methods: new Set(methods), handler })
  }

  /** Throws when a registered route sits on the MCP endpoint path. Called at HTTP startup. */
  assertNoMcpCollision(mcpPath: string): void {
    if (this._routes.has(mcpPath)) {
      throw new Error(
        `customRoute path ${mcpPath} collides with the MCP endpoint path; move the route or the MCP \`path\``,
      )
    }
  }

  /** Match a request path + method. OPTIONS never matches (preflight owns it). */
  match(pathname: string, method: string): RouteMatch | null {
    const route = this._routes.get(pathname)
    if (!route) return null
    const upper = method.toUpperCase()
    if (upper === 'OPTIONS') return null
    if (route.methods.has(upper)) return { kind: 'handler', handler: route.handler }
    return { kind: 'method-mismatch', allow: [...route.methods].join(', ') }
  }

  paths(): string[] {
    return [...this._routes.keys()]
  }

  get size(): number {
    return this._routes.size
  }
}

/** Statuses the fetch spec forbids a body on. `new Response(body, { status })`
 * throws for these when `body` is anything but `null`/`undefined` — including `''`. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * Resolve `RunOptions.health` to a concrete endpoint config, or null when the
 * endpoint is off. Throws on malformed values so a JS caller fails at startup,
 * for every transport (the `stateless` precedent).
 */
export function resolveHealth(health: boolean | HealthOptions | undefined): ResolvedHealth | null {
  if (health === undefined || health === false) return null
  if (health === true) return { path: '/healthz', status: 200, body: 'ok' }
  if (typeof health !== 'object' || health === null) {
    throw new Error(`Invalid health option: expected boolean or object, got ${typeof health}`)
  }
  if (health.enabled === false) return null
  const path = health.path ?? '/healthz'
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`Invalid health.path: must be a string starting with "/", got: ${JSON.stringify(health.path)}`)
  }
  const status = health.status ?? 200
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`Invalid health.status: must be an integer HTTP status code, got: ${JSON.stringify(health.status)}`)
  }
  const body = health.body ?? 'ok'
  if (typeof body !== 'string') {
    throw new Error(`Invalid health.body: must be a string, got: ${typeof health.body}`)
  }
  if (body !== '' && NULL_BODY_STATUSES.has(status)) {
    throw new Error(
      `Invalid health config: status ${status} cannot carry a response body (the fetch spec forbids one on ` +
        `101/204/205/304); set body: '' or choose a different status`,
    )
  }
  return { path, status, body }
}

/**
 * Serve one matched route on the Node listener: convert the request with
 * `toWebRequest`, run the handler, write its Response back verbatim
 * (streaming bodies included). A throwing handler answers 500 JSON and logs,
 * matching the stateless legacy handler's error posture.
 */
export async function serveCustomRouteNode(
  handler: CustomRouteHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { toWebRequest } = await import('@modelcontextprotocol/node')
  let response: Response
  try {
    response = await handler(await toWebRequest(req))
  } catch (error) {
    console.error('[fastmcp] custom route handler failed:', error)
    res
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Internal Server Error' }))
    return
  }
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body) {
    const stream = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
    stream.on('error', (error) => {
      console.error('[fastmcp] custom route response stream failed:', error)
      res.destroy()
    })
    stream.pipe(res)
  } else {
    res.end()
  }
}

/** 405 for a route path hit with a method outside its `methods` list. */
export function writeMethodNotAllowed(res: ServerResponse, allow: string): void {
  res
    .writeHead(405, { Allow: allow, 'Content-Type': 'application/json' })
    .end(JSON.stringify({ error: 'Method Not Allowed' }))
}
