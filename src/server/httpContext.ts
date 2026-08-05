import type { IncomingMessage } from 'node:http'

/**
 * Header names whose VALUES are credentials for this hop. Withheld from
 * `ctx.http.headers` by default (observable via `redactedHeaderNames`) and
 * dropped by `forwardableHeaders`. Adjust per deployment with
 * `FastMCPOptions.http.redactHeaders` / `exposeHeaders`.
 */
export const DEFAULT_SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'mcp-session-id',
]

/**
 * Effective sensitive-header set: the defaults, plus `redactHeaders`, minus
 * `exposeHeaders`. Names are compared lowercased (HTTP headers are
 * case-insensitive).
 */
export function resolveSensitiveHeaders(options?: {
  redactHeaders?: string[]
  exposeHeaders?: string[]
}): Set<string> {
  const set = new Set<string>(DEFAULT_SENSITIVE_HEADERS)
  for (const h of options?.redactHeaders ?? []) set.add(h.toLowerCase())
  for (const h of options?.exposeHeaders ?? []) set.delete(h.toLowerCase())
  return set
}

/**
 * Read-only, per-request snapshot of the HTTP request that carried the current
 * MCP message. Present wherever the server is reached over an HTTP transport;
 * `undefined` on stdio.
 *
 * REDACTION: credential headers (see {@link DEFAULT_SENSITIVE_HEADERS}, tuned
 * by `FastMCPOptions.http`) are withheld from `headers` and listed in
 * `redactedHeaderNames`, so a `null` lookup is never silent. The redaction
 * guards accidental egress: tool results and logs flow into model context by
 * design. A `RequestVerifier` receives the FULL wire headers instead (its
 * `redactedHeaderNames` is empty): the verifier is the credential-handling
 * code.
 *
 * TRUST: every value here is client-controlled input. Nothing in this object
 * is authenticated. Do not derive authorization from it in handlers. For
 * header-established identity (trusted reverse proxy), configure
 * `FastMCPOptions.auth` with a `RequestVerifier` so identity flows through
 * `ctx.auth` like every other authenticated request. See docs:
 * servers/auth/trusted-proxy.
 */
export interface HttpRequestContext {
  /** Headers of the carrying HTTP request, minus the sensitive set. A per-request copy; mutations affect nothing. */
  readonly headers: Headers
  /** Names (lowercase, sorted) that were present on the wire but withheld from `headers`. */
  readonly redactedHeaderNames: readonly string[]
  /** HTTP method of the carrying request (e.g. 'POST'). */
  readonly method: string
  /**
   * Origin-form request target (path + query, e.g. '/mcp?tenant=a'). Scheme and
   * authority are deliberately absent: behind a proxy this server cannot know
   * the external URL. Reconstruct it from your proxy's forwarded headers if you
   * need it.
   */
  readonly url: string
}

/**
 * Build an {@link HttpRequestContext} from a web-standard Request (the SDK's
 * `ctx.http.req`), withholding `sensitiveHeaders`.
 */
export function buildHttpRequestContext(
  req: Request,
  sensitiveHeaders: ReadonlySet<string>,
): HttpRequestContext {
  const headers = new Headers()
  const redacted: string[] = []
  req.headers.forEach((value, name) => {
    // Headers.forEach reports names lowercased.
    if (sensitiveHeaders.has(name)) {
      redacted.push(name)
      return
    }
    headers.append(name, value)
  })
  redacted.sort()
  let url: string
  try {
    const u = new URL(req.url)
    url = u.pathname + u.search
  } catch {
    url = req.url // already origin-form
  }
  return { headers, redactedHeaderNames: redacted, method: req.method, url }
}

/**
 * Build an {@link HttpRequestContext} from a Node IncomingMessage, with NO
 * redaction. This feeds `RequestVerifier.verifyRequest` at the HTTP auth gate;
 * the verifier is the credential-handling code and must see the wire.
 */
export function nodeRequestToHttpContext(req: IncomingMessage): HttpRequestContext {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v)
    } else {
      headers.append(name, value)
    }
  }
  return { headers, redactedHeaderNames: [], method: req.method ?? 'GET', url: req.url ?? '/' }
}

const UNFORWARDABLE = new Set([
  // credentials (see also DEFAULT_SENSITIVE_HEADERS; kept here too so the
  // helper is safe on Headers that did not come from a redacted ctx.http)
  'authorization', 'cookie', 'proxy-authorization', 'proxy-authenticate',
  // hop-by-hop (RFC 9110 §7.6.1) and connection management
  'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
  // message framing / target-specific
  'host', 'content-length', 'content-type', 'expect',
])

/**
 * Copy of `headers` that is safe to attach to an outbound request to another
 * service. Drops credentials (authorization, cookie, proxy-*), hop-by-hop
 * headers, message-framing headers (host, content-length, content-type,
 * expect), and every `mcp-*` protocol header. Deployment-specific credential
 * headers are covered by `FastMCPOptions.http.redactHeaders`: they are already
 * absent from `ctx.http.headers`. `include` re-admits specific names.
 * Re-admitting 'authorization' forwards the caller's credential; the MCP spec
 * forbids passing the inbound token to upstream APIs, so mint your own
 * upstream credential instead.
 */
export function forwardableHeaders(
  headers: Headers,
  options?: { include?: string[] },
): Headers {
  const include = new Set((options?.include ?? []).map((h) => h.toLowerCase()))
  const out = new Headers()
  headers.forEach((value, name) => {
    if (include.has(name)) {
      out.append(name, value)
      return
    }
    if (UNFORWARDABLE.has(name) || name.startsWith('mcp-')) return
    out.append(name, value)
  })
  return out
}
