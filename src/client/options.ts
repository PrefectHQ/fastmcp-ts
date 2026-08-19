import type {
  ClientCapabilities,
  Implementation,
  InputRequiredOptions,
  PriorDiscovery,
  ResponseCacheStore,
  VersionNegotiationOptions,
} from '@modelcontextprotocol/client'
import type { AsyncHeaderAuth, BearerAuth, OAuth } from './auth.js'
import type { ClientHandlers } from './handlers.js'
import type { Root } from './results.js'

export const DEFAULT_CLIENT_INFO: Implementation = {
  name: 'fastmcp-ts',
  version: '1.0.0',
}

export interface ClientDefaultOptions {
  /** Global fallback timeout in seconds for all requests. */
  timeout?: number
  tool?: { timeout?: number }
  resource?: { timeout?: number }
  prompt?: { timeout?: number }
}

/** A single element of the roots option: a URI string or a full Root object. */
export type RootInput = string | Root

/**
 * Static list of roots, or an async callback invoked on each roots/list request.
 * URI strings are normalised to file:// URIs automatically; relative paths are
 * resolved against process.cwd().
 */
export type RootsValue = RootInput[] | (() => RootInput[] | Promise<RootInput[]>)

export interface ClientOptions {
  /**
   * Authentication to attach to HTTP requests.
   * A plain string is treated as a Bearer token.
   */
  auth?: BearerAuth | OAuth | AsyncHeaderAuth | string
  /**
   * Identity to advertise to the MCP server. Defaults to FastMCP's own client
   * identity. Set this when FastMCP is embedded in another application.
   */
  clientInfo?: Implementation
  handlers?: ClientHandlers
  /**
   * Additional capabilities to advertise to the server. FastMCP preserves
   * their settings while adding capabilities inferred from handlers and roots.
   */
  capabilities?: ClientCapabilities
  /**
   * Filesystem roots to advertise to the server.
   * Accepts a static array of strings / Root objects, or an async callback
   * invoked on each roots/list request (useful for dynamic root sets).
   */
  roots?: RootsValue
  /**
   * When true (default), the MCP initialize handshake is performed
   * automatically inside connect().
   */
  autoInitialize?: boolean
  defaultOptions?: ClientDefaultOptions
  /**
   * Protocol version negotiation (protocol revision 2026-07-28 and later).
   * The default is `{ mode: 'auto' }`: connect() probes the server once with
   * `server/discover` and uses the modern (2026-07-28) era on definitive
   * modern evidence, falling back to the plain legacy `initialize` handshake
   * on anything else (a method-not-found answer, silence on a local stdio
   * pipe, a probe child that exits). The probe is stall-safe in the SDK: on
   * stdio it runs against a short-lived sibling process and a timeout falls
   * back to legacy, while on HTTP — where silence means an outage — a probe
   * timeout rejects with a typed error instead of hanging. Pass
   * `{ mode: 'legacy' }` to opt out: no probe, the 2025 sequence
   * byte-identical to prior behavior. Pass `{ mode: { pin: '2026-07-28' } }`
   * to require the modern era outright — connect() throws if the server
   * cannot speak it. See `getProtocolEra()` to read the negotiated result
   * after connecting.
   */
  versionNegotiation?: VersionNegotiationOptions
  /**
   * A cached era verdict from a previous connection to the same server, so
   * connect() can skip the `server/discover` probe entirely. Takes precedence
   * over `versionNegotiation`. `{ kind: 'modern', discover }` adopts a prior
   * `DiscoverResult` with zero round trips; `{ kind: 'legacy' }` skips the probe
   * and runs the plain legacy `initialize` handshake. Freshness is the caller's
   * responsibility — a stale modern verdict fails loudly at the first request; a
   * stale legacy verdict succeeds silently forever. Reuse only within one
   * authorization context.
   */
  prior?: PriorDiscovery
  /**
   * Multi-round-trip auto-fulfilment (protocol revision 2026-07-28). On the
   * modern era, servers obtain client input (elicitation, sampling, roots) by
   * answering a request with an `input_required` result instead of a
   * server→client request. By default the client fulfils these automatically
   * through the same `handlers.sampling`/`handlers.elicitation` callbacks,
   * retrying up to `maxRounds` times. Set `autoFulfill: false` for manual mode.
   * Has no effect on legacy-era connections. Passed through verbatim to the SDK
   * client.
   */
  inputRequired?: InputRequiredOptions
  /**
   * The response-cache store backing cacheable results (SEP-2549 `ttlMs`/
   * `cacheScope` hints on `listTools`/`listResources`/`listResourceTemplates`/
   * `listPrompts`/`readResource`). Defaults to a fresh in-memory store per
   * client (the SDK's own default) when omitted. Passed through verbatim.
   */
  responseCacheStore?: ResponseCacheStore
  /**
   * Opaque per-principal identifier for response-cache writes whose
   * server-reported `cacheScope` is `'private'`. Set this to a stable identity
   * of the authorization context (e.g. the auth subject) when one
   * `responseCacheStore` backs several principals. Passed through verbatim.
   */
  cachePartition?: string
  /**
   * TTL (ms) applied when a cacheable result arrives without a `ttlMs` field.
   * Default `0` (never served from cache, but still stored). Passed through
   * verbatim.
   */
  defaultCacheTtlMs?: number
  /**
   * Allow the deprecated SSE transport when a target URL's path indicates SSE
   * (e.g. ends in `/sse`). Default `false` — such URLs throw a clear error
   * pointing at Streamable HTTP and this flag, rather than silently connecting
   * over a transport the MCP SDK itself marks `@deprecated`. When enabled, a
   * one-time deprecation warning is logged via `console.warn`.
   */
  legacySSE?: boolean
}
