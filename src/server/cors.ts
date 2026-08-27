/**
 * Configurable CORS for the HTTP listener `run()` starts (both the plain and
 * the OAuth serve paths). Resolution and header computation are pure
 * functions: `resolveCors` runs once, in the FastMCP constructor, and fails
 * loudly on malformed config (the `resolveHealth` precedent); the two header
 * builders run per request.
 *
 * `fetch()` is deliberately untouched: the embedding framework owns CORS at
 * its HTTP boundary, exactly as it owns Host/Origin validation.
 */

/** `FastMCPOptions.http.cors` object form. `true` and omitted mean the
 * permissive defaults; `false` disables CORS handling entirely (no global
 * preflight, no headers). */
export interface CorsOptions {
  /**
   * Origins allowed to call the MCP endpoint from a browser, compared
   * against the request's `Origin` header. `'*'` (the default) allows every
   * origin. A string or array allows exactly those `scheme://host[:port]`
   * origins. A function receives the `Origin` value and returns whether it
   * is allowed.
   */
  origin?: string | string[] | ((origin: string) => boolean)
  /** `Access-Control-Allow-Methods` value; replaces the default
   * `GET, POST, DELETE, OPTIONS` list verbatim. */
  methods?: string[]
  /** Extra request headers for `Access-Control-Allow-Headers`, added to the
   * defaults. The MCP protocol headers are never removed: silently dropping
   * one would break browser clients in ways that only surface in
   * production. */
  allowedHeaders?: string[]
  /** Extra response headers for `Access-Control-Expose-Headers`, added to
   * the default `Mcp-Session-Id` (legacy sessionful browser clients must
   * read it from the initialize response). */
  exposedHeaders?: string[]
  /** Send `Access-Control-Allow-Credentials: true`. Requires an explicit
   * non-`'*'` `origin`: browsers reject `*` on credentialed requests, so
   * that combination is a construction-time error. */
  credentials?: boolean
  /** `Access-Control-Max-Age` for preflight caching, in seconds. */
  maxAge?: number
}

export type OriginMode =
  | { kind: 'any' }
  | { kind: 'list'; origins: ReadonlySet<string> }
  | { kind: 'predicate'; test: (origin: string) => boolean }

/** Precomputed CORS state: list values are joined once at construction. */
export interface ResolvedCors {
  originMode: OriginMode
  methods: string
  allowedHeaders: string
  exposedHeaders: string
  credentials: boolean
  maxAge: number | null
}

export const DEFAULT_CORS_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS']

// Mcp-Session-Id: legacy (2025-era) session routing, still served alongside
// modern traffic. MCP-Protocol-Version/Mcp-Method/Mcp-Name: required standard
// headers for 2026-07-28 requests (SEP-2243). Mcp-Param-* (tool-argument
// mirroring) is deliberately not listed: browser clients skip that mirroring
// entirely (dynamically named headers cannot be statically allow-listed for
// credentialed CORS), so no browser ever needs to send it.
export const DEFAULT_CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Mcp-Session-Id',
  'MCP-Protocol-Version',
  'Mcp-Method',
  'Mcp-Name',
]

export const DEFAULT_CORS_EXPOSED_HEADERS = ['Mcp-Session-Id']

function mergedHeaderList(defaults: readonly string[], extra: string[] | undefined, option: string): string {
  if (extra !== undefined && !Array.isArray(extra)) {
    throw new Error(`Invalid cors.${option}: must be an array of header names, got: ${JSON.stringify(extra)}`)
  }
  const merged = [...defaults]
  const seen = new Set(defaults.map((h) => h.toLowerCase()))
  for (const header of extra ?? []) {
    if (typeof header !== 'string' || header.trim() === '') {
      throw new Error(`Invalid cors.${option}: entries must be non-empty strings, got: ${JSON.stringify(header)}`)
    }
    if (!seen.has(header.toLowerCase())) {
      seen.add(header.toLowerCase())
      merged.push(header)
    }
  }
  return merged.join(', ')
}

function resolveOriginMode(origin: CorsOptions['origin']): OriginMode {
  if (origin === undefined || origin === '*') return { kind: 'any' }
  if (typeof origin === 'function') return { kind: 'predicate', test: origin }
  const list = typeof origin === 'string' ? [origin] : origin
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `Invalid cors.origin: expected '*', an origin, a non-empty array of origins, or a function, got: ${JSON.stringify(origin)}`,
    )
  }
  for (const entry of list) {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`Invalid cors.origin: entries must be non-empty strings, got: ${JSON.stringify(entry)}`)
    }
    if (entry.endsWith('/')) {
      throw new Error(
        `Invalid cors.origin "${entry}": an Origin header never carries a trailing slash, so this entry can never match; drop the trailing slash`,
      )
    }
  }
  return { kind: 'list', origins: new Set(list) }
}

/** Resolve `FastMCPOptions.http.cors`. Returns null when disabled; throws on
 * malformed config so a JS caller fails at construction, for every transport. */
export function resolveCors(cors: boolean | CorsOptions | undefined): ResolvedCors | null {
  if (cors === false) return null
  const opts: CorsOptions = cors === undefined || cors === true ? {} : cors
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new Error(`Invalid cors option: expected boolean or object, got ${typeof cors}`)
  }
  const originMode = resolveOriginMode(opts.origin)
  if (opts.credentials === true && originMode.kind === 'any') {
    throw new Error(
      "Invalid cors config: credentials: true requires an explicit origin — browsers reject 'Access-Control-Allow-Origin: *' on credentialed requests; set cors.origin to your site origin(s)",
    )
  }
  let methods = DEFAULT_CORS_METHODS
  if (opts.methods !== undefined) {
    if (!Array.isArray(opts.methods) || opts.methods.length === 0) {
      throw new Error('Invalid cors.methods: must be a non-empty array of method names')
    }
    methods = [
      ...new Set(
        opts.methods.map((m) => {
          if (typeof m !== 'string' || m.trim() === '') {
            throw new Error(`Invalid cors.methods: entries must be non-empty strings, got: ${JSON.stringify(m)}`)
          }
          return m.toUpperCase()
        }),
      ),
    ]
  }
  const maxAge = opts.maxAge ?? null
  if (maxAge !== null && (!Number.isInteger(maxAge) || maxAge < 0)) {
    throw new Error(`Invalid cors.maxAge: must be a non-negative integer (seconds), got: ${JSON.stringify(opts.maxAge)}`)
  }
  return {
    originMode,
    methods: methods.join(', '),
    allowedHeaders: mergedHeaderList(DEFAULT_CORS_ALLOWED_HEADERS, opts.allowedHeaders, 'allowedHeaders'),
    exposedHeaders: mergedHeaderList(DEFAULT_CORS_EXPOSED_HEADERS, opts.exposedHeaders, 'exposedHeaders'),
    credentials: opts.credentials === true,
    maxAge,
  }
}

/** The `Access-Control-Allow-Origin` value for this request, or null when the
 * origin is not allowed (or absent, under a non-`any` mode). */
function allowOriginValue(cors: ResolvedCors, requestOrigin: string | undefined): string | null {
  switch (cors.originMode.kind) {
    case 'any':
      return '*'
    case 'list':
      return requestOrigin !== undefined && cors.originMode.origins.has(requestOrigin) ? requestOrigin : null
    case 'predicate':
      return requestOrigin !== undefined && cors.originMode.test(requestOrigin) ? requestOrigin : null
  }
}

function baseHeaders(cors: ResolvedCors, requestOrigin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  // Any non-static ACAO makes the response vary by Origin; shared caches must
  // never serve one origin's copy to another. Set even on rejected origins.
  if (cors.originMode.kind !== 'any') headers['Vary'] = 'Origin'
  const origin = allowOriginValue(cors, requestOrigin)
  if (origin === null) return headers
  headers['Access-Control-Allow-Origin'] = origin
  if (cors.credentials) headers['Access-Control-Allow-Credentials'] = 'true'
  return headers
}

/** Headers for the global `OPTIONS` preflight answer (204). */
export function corsPreflightHeaders(cors: ResolvedCors, requestOrigin: string | undefined): Record<string, string> {
  const headers = baseHeaders(cors, requestOrigin)
  if (headers['Access-Control-Allow-Origin'] === undefined) return headers
  headers['Access-Control-Allow-Methods'] = cors.methods
  headers['Access-Control-Allow-Headers'] = cors.allowedHeaders
  if (cors.maxAge !== null) headers['Access-Control-Max-Age'] = String(cors.maxAge)
  return headers
}

/** Headers attached to every MCP-endpoint response, auth failures included,
 * so a browser can read the 401 challenge. */
export function corsResponseHeaders(cors: ResolvedCors, requestOrigin: string | undefined): Record<string, string> {
  const headers = baseHeaders(cors, requestOrigin)
  if (headers['Access-Control-Allow-Origin'] === undefined) return headers
  headers['Access-Control-Expose-Headers'] = cors.exposedHeaders
  return headers
}
