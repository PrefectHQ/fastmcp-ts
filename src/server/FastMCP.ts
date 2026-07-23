import type { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import type { OAuthServerProvider } from "@modelcontextprotocol/server-legacy/auth";
import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError, Server, createMcpHandler, isLegacyRequest, isJsonContentType, createRequestStateCodec, localhostAllowedHostnames, localhostAllowedOrigins, assertCompleteRequestPrompt, assertCompleteRequestResourceTemplate } from "@modelcontextprotocol/server";
import type { Transport, AuthInfo, ListToolsResult, GetPromptResult, CompleteRequestParams, CompleteResult, McpHttpHandler, McpHandlerRequestOptions, CacheHint, RequestStateCodec, ServerContext, ServerEventBus } from "@modelcontextprotocol/server";

// Not exported by @modelcontextprotocol/server (CacheableResultMethod is internal-only);
// mirrors its CACHEABLE_RESULT_METHODS literal union (SEP-2549 cacheable operations).
type CacheableResultMethod =
  | 'tools/list'
  | 'prompts/list'
  | 'resources/list'
  | 'resources/templates/list'
  | 'resources/read'
  | 'server/discover'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthorizationError } from './auth/types'
import type { TokenVerifier, AccessToken } from './auth/types'
import type { AuthCheck } from './auth/authorization'
import { BoundedEventStore, LEGACY_SSE_RETRY_MS } from './legacyEventStore'
import { contextStore, createContext, SESSION_CLOSE_CALLBACKS_KEY } from './context'
import type { McpContext } from './context'
import { runMiddlewareChain } from './middleware'
import type { Middleware } from './middleware'
import { applyTransformChain } from './transform'
import type { Transform, ToolView, ResourceView, PromptView, SynthesizedTool } from './transform'
import { convertResult, toJsonSchema, validateInput, ToolResult } from './tool'
import { isInputRequiredResult } from './mrtr'
import {
  convertResourceResult,
  isUriTemplate,
  matchTemplate,
  ResourceResult,
} from './resource'
import type { ResourceConfig } from './resource'
import { UI_EXTENSION_KEY, UI_RESOURCE_MIME_TYPE, isUiCapable } from './apps/types'
import type { UiToolMeta } from './apps/types'
import { convertPromptResult, PromptResult } from './prompt'
import type { PromptConfig } from './prompt'
import { normalizeCompletion, EMPTY_COMPLETION } from './completion'

function prefixResourceUri(uri: string, prefix: string): string {
  const idx = uri.indexOf('://')
  if (idx === -1) return `${prefix}/${uri}`
  return `${uri.slice(0, idx + 3)}${prefix}/${uri.slice(idx + 3)}`
}

export interface OAuthConfig {
  /** OAuth server provider implementing the authorization and token flow. */
  provider: OAuthServerProvider
  /**
   * Issuer URL for the OAuth server (used in metadata endpoints).
   * Defaults to the HTTP server's bound address when not specified.
   */
  issuerUrl?: URL
  /** Scopes supported by this server, advertised in OAuth metadata. */
  scopes?: string[]
}

export interface FastMCPOptions {
  name: string
  version?: string
  /** Simple bearer-token verifier for non-OAuth auth scenarios. */
  auth?: TokenVerifier
  /** Full OAuth 2.1 server with Dynamic Client Registration support. */
  oauth?: OAuthConfig
  /** Maximum number of tools returned per listTools page. Default: 50. */
  toolsPageSize?: number
  /** Maximum number of resources (or templates) returned per page. Default: 50. */
  resourcesPageSize?: number
  /** Maximum number of prompts returned per prompts/list page. Default: 50. */
  promptsPageSize?: number
  /** Middleware applied to every request in registration order. */
  middleware?: Middleware[]
  /** Transforms applied to component list responses in registration order. */
  transforms?: Transform[]
  /**
   * Cache hints (`ttlMs` / `cacheScope`) for the 2026-07-28 protocol revision's
   * cacheable results (`tools/list`, `prompts/list`, `resources/list`,
   * `resources/templates/list`, `resources/read`, `server/discover`), keyed by
   * operation. Only affects modern (2026-07-28) responses — 2025-era responses
   * never carry these fields. Omitted operations (or omitting this option
   * entirely) keep the conservative defaults (`ttlMs: 0`, `cacheScope: 'private'`).
   * Applies uniformly per operation; per-resource cache hints are not currently
   * supported (that per-registration override is only available through the
   * SDK's high-level `McpServer.registerResource`, which FastMCP does not use).
   */
  cacheHints?: Partial<Record<CacheableResultMethod, CacheHint>>
  /**
   * HMAC-SHA256 integrity protection for multi-round-trip `requestState`
   * (protocol revision 2026-07-28) — see `ctx.requestState()` / `ctx.mintRequestState()`.
   * Backed by the SDK's `createRequestStateCodec`. When omitted, `requestState` passes
   * through unverified (the raw wire string) — the client can read and tamper with it,
   * so this MUST be configured for any flow whose `requestState` influences
   * authorization, resource access, or business logic.
   */
  requestState?: {
    /** HMAC secret. A `string` is UTF-8-encoded; MUST be at least 32 bytes (256 bits). */
    key: Uint8Array | string
    /** How long a minted `requestState` stays valid, in seconds. Default: 600 (10 minutes). */
    ttlSeconds?: number
    /** Binds a minted `requestState` to, e.g., the authenticated principal and/or the
     * originating method — a value minted under one binding is rejected when echoed
     * under a different one. See `RequestStateCodecOptions.bind`. */
    bind?: (ctx: ServerContext) => string
  }
  /**
   * Multi-round-trip (`inputRequired`) serving knobs (protocol revision 2026-07-28).
   * On 2026-era requests the client fulfils `input_required` returns directly; on
   * 2025-era connections the SDK's legacy shim fulfils them server-side (real
   * server→client requests + handler re-entry) — so handlers written with
   * `inputRequired(...)` serve both eras unchanged.
   */
  inputRequired?: {
    /** Handler re-entries per originating request before the shim fails (legacy era
     * only). Default: 8. */
    maxRounds?: number
    /** Per-leg timeout (ms) for the legacy shim's embedded server→client requests.
     * Default: 600_000 (10 minutes) — human-paced, deliberately above the 60s protocol default. */
    roundTimeoutMs?: number
    /** `false` disables the legacy shim: an `inputRequired(...)` return on a 2025-era
     * request fails loudly instead of being bridged. Default: true. */
    legacyShim?: boolean
  }
  /**
   * The change-event bus modern (2026-07-28) `subscriptions/listen` streams
   * subscribe to, and `tool()`/`resource()`/`prompt()` registration publishes
   * change events onto. Defaults to an in-process bus, which is correct for a
   * single server process. Supply your own `ServerEventBus` implementation over a
   * shared pub/sub backend (e.g. Redis) for a horizontally-scaled deployment,
   * where a `subscriptions/listen` stream and the request that changed the list it
   * cares about may land on different processes.
   */
  eventBus?: ServerEventBus
  /**
   * DNS-rebinding protection for the HTTP transport: validates the `Host` and
   * `Origin` request headers (port-agnostic, by hostname) and rejects mismatches
   * with `403`. Defends localhost servers against a malicious web page whose DNS
   * rebinds to `127.0.0.1` (MCP transport security best practice). Only affects the
   * HTTP transport — stdio is unaffected.
   *
   * Default posture (option omitted): protection auto-enables when, and only when,
   * `run()` binds the HTTP server to a loopback host (`127.0.0.1`, `::1`,
   * `localhost`) — the deployment the attack targets. A server bound to a routable
   * interface (e.g. `0.0.0.0` or a public host) is left open by default, because a
   * localhost-only allowlist would reject its legitimate traffic; such deployments
   * must opt in with an explicit `allowedHosts`/`allowedOrigins` for their domain.
   */
  dnsRebinding?: {
    /** Force protection on (`true`) or off (`false`). Omit for the loopback-auto default. */
    enabled?: boolean
    /**
     * Allowed `Host` header hostnames (no port; IPv6 in brackets, e.g. `[::1]`).
     * Supplying this list also implies protection on. Default: `localhost`,
     * `127.0.0.1`, `[::1]`.
     */
    allowedHosts?: string[]
    /**
     * Allowed `Origin` header hostnames (a missing `Origin` always passes — non-browser
     * clients send none). Supplying this list also implies protection on. Default:
     * `localhost`, `127.0.0.1`, `[::1]`.
     */
    allowedOrigins?: string[]
  }
}

export interface RunOptions {
  transport?: 'stdio' | 'http'
  port?: number
  host?: string
  path?: string
  /** Custom stdin stream for the stdio transport. Defaults to process.stdin. */
  stdin?: Readable
  /** Custom stdout stream for the stdio transport. Defaults to process.stdout. */
  stdout?: Writable
}

export interface ServerAddress {
  host: string
  port: number
  path: string
}

export interface ToolConfig {
  name: string
  /** Human-readable display name shown in UIs. Takes precedence over `name` for display purposes. */
  title?: string
  description: string
  /** Standard Schema validator for the tool's input arguments. Used for runtime validation. */
  input?: StandardSchemaV1
  /**
   * Explicit JSON Schema advertised to clients as `inputSchema`. Overrides auto-generation from
   * `input`. Use when you need JSON Schema features beyond what your validator auto-generates
   * (e.g. `examples`, `$comment`, per-property descriptions, or custom annotations).
   */
  inputSchema?: Record<string, unknown>
  /** Standard Schema validator for the tool's return value. Validated before result conversion. */
  output?: StandardSchemaV1
  /**
   * Explicit JSON Schema advertised to clients as `outputSchema`. Overrides auto-generation from
   * `output`. Use when you need JSON Schema features beyond what your validator auto-generates.
   */
  outputSchema?: Record<string, unknown>
  /** Execution timeout in milliseconds. No timeout by default. */
  timeout?: number
  /** When true the tool is hidden from listTools and cannot be invoked via tools/call. */
  disabled?: boolean
  /** Arbitrary tags for server-side filtering. */
  tags?: string[]
  auth?: AuthCheck
  /** Apps extension — links this tool to a UI resource and controls visibility. */
  ui?: UiToolMeta
}

interface RegisteredTool {
  config: ToolConfig
  handler: (args: unknown) => unknown
}

interface RegisteredResource {
  config: ResourceConfig
  handler: (params?: Record<string, string>) => unknown
}

interface ResolvedPromptConfig extends Required<Pick<PromptConfig, 'name' | 'description'>> {
  title?: string
  arguments?: PromptConfig['arguments']
  disabled?: boolean
  timeout?: number
  tags?: string[]
  auth?: PromptConfig['auth']
}

interface RegisteredPrompt {
  config: ResolvedPromptConfig
  handler: (args?: Record<string, string>) => unknown
}

interface Session {
  transport: NodeStreamableHTTPServerTransport
  server: Server
  state: Map<string, unknown>
}

/**
 * Per-session state key holding the set of resource URIs the connection has
 * subscribed to via `resources/subscribe`. Stored in the same per-session state
 * Map as `SESSION_CLOSE_CALLBACKS_KEY`, so it is torn down with the session (no
 * separate registry to leak). Only ever populated on legacy connections — the
 * modern era rejects the RPC at the wire seam before the handler runs.
 */
const RESOURCE_SUBSCRIPTIONS_KEY = '__fastmcp_resource_subscriptions'

/** Converts a camelCase or PascalCase name to space-separated words. e.g. `getWeather` → `"get weather"` */
function inferDescription(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase()
}

/** True when `host` is a loopback address `run()` can bind — the deployment DNS-rebinding targets. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

// Fired at most once per process: an HTTP serve on a routable host with no dnsRebinding
// config at all. Any explicit dnsRebinding option (even `enabled: false`) suppresses the
// warning — silence means the operator chose the open posture on purpose.
let _dnsRebindingWarned = false

/** @internal Test-only reset of the once-per-process DNS-rebinding warning guard. Not
 * re-exported from `fastmcp-ts/server` (index.ts names its exports). */
export function __resetDnsRebindingWarningForTests(): void {
  _dnsRebindingWarned = false
}

function toAccessToken(authInfo: AuthInfo | undefined): AccessToken | undefined {
  if (!authInfo) return undefined
  return {
    token: authInfo.token,
    clientId: authInfo.clientId || undefined,
    scopes: authInfo.scopes,
    expiresAt: authInfo.expiresAt,
    claims: authInfo.extra ?? {},
  }
}

// Cached result of verifying FASTMCP_CLI_AUTH_TOKEN once per process.
// undefined = not yet resolved; null = env var absent or verification failed.
let _cliEnvToken: AccessToken | null | undefined

async function resolveCliEnvToken(verifier: TokenVerifier | undefined): Promise<AccessToken | undefined> {
  if (!verifier) return undefined
  if (_cliEnvToken !== undefined) return _cliEnvToken ?? undefined
  const raw = process.env['FASTMCP_CLI_AUTH_TOKEN']
  if (!raw) { _cliEnvToken = null; return undefined }
  try {
    _cliEnvToken = await verifier.verify(raw)
    return _cliEnvToken
  } catch {
    _cliEnvToken = null
    return undefined
  }
}

async function runAuthCheck(check: AuthCheck, token: AccessToken | undefined): Promise<void> {
  if (!token) throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Authentication required')
  try {
    await check(token)
  } catch (err) {
    if (err instanceof AuthorizationError) {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, err.message)
    }
    throw err
  }
}

export class FastMCP {
  readonly name: string
  readonly version: string

  private _auth: TokenVerifier | undefined
  private _oauth: OAuthConfig | undefined
  private _toolsPageSize: number
  private _resourcesPageSize: number
  private _tools = new Map<string, RegisteredTool>()
  private _staticResources = new Map<string, RegisteredResource>()
  private _templateResources = new Map<string, RegisteredResource>()
  private _prompts = new Map<string, RegisteredPrompt>()
  private _promptsPageSize: number
  private _middleware: Middleware[]
  private _transforms: Transform[]
  private _cacheHints: Partial<Record<CacheableResultMethod, CacheHint>> | undefined
  private _requestStateCodec: RequestStateCodec | undefined
  private _inputRequiredOptions: FastMCPOptions['inputRequired']
  private _eventBus: ServerEventBus | undefined
  private _dnsRebindingOptions: FastMCPOptions['dnsRebinding']
  // DNS-rebinding guards, resolved once per serve from _dnsRebindingOptions + the bind
  // host. null = protection off. Each returns false (and has already written a 403) when
  // it rejects; see the SDK's hostHeaderValidation/originValidation Node middleware.
  private _hostGuard: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null
  private _originGuard: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null
  private _primaryState = new Map<string, unknown>()
  private _httpServer: HttpServer | null = null
  private _address: ServerAddress | null = null
  private _isRunning = false
  private _sessions = new Map<string, Session>()
  // Primary server used by connect() (in-process transports — always 2025-era)
  private _primaryServer: Server
  // The pinned Server instance for a run({transport:'stdio'}) connection (2025- or
  // 2026-era, decided by serveStdio's opening handshake). Null unless serving stdio.
  private _stdioServer: Server | null = null
  // The state Map paired with `_stdioServer` for the current stdio connection.
  // Holds this connection's resource-subscription set; read by the resource-updated
  // fan-out. Null unless serving stdio.
  private _stdioState: Map<string, unknown> | null = null
  private _stdioHandle: { close(): Promise<void> } | null = null
  // Modern (2026-07-28) HTTP handler — one per FastMCP instance, lazily created.
  // Builds a fresh Server (via _makeServer) per request; see createMcpHandler.
  private _modernHandler: McpHttpHandler | null = null

  private _toolRegisteredCallbacks: Array<(tool: RegisteredTool) => void> = []
  private _resourceRegisteredCallbacks: Array<(resource: RegisteredResource) => void> = []
  private _promptRegisteredCallbacks: Array<(prompt: RegisteredPrompt) => void> = []
  private _proxyCloseCallbacks: Array<() => Promise<void>> = []
  private _mountedChildren = new Set<FastMCP>()

  constructor(options: FastMCPOptions) {
    this.name = options.name
    this.version = options.version ?? '0.0.1'
    this._auth = options.auth
    this._oauth = options.oauth
    this._toolsPageSize = options.toolsPageSize ?? 50
    this._resourcesPageSize = options.resourcesPageSize ?? 50
    this._promptsPageSize = options.promptsPageSize ?? 50
    this._middleware = options.middleware ? [...options.middleware] : []
    this._transforms = options.transforms ? [...options.transforms] : []
    this._cacheHints = options.cacheHints
    this._requestStateCodec = options.requestState
      ? createRequestStateCodec(options.requestState)
      : undefined
    this._inputRequiredOptions = options.inputRequired
    this._eventBus = options.eventBus
    this._dnsRebindingOptions = options.dnsRebinding
    this._primaryServer = this._makeServer()
  }

  private _hasUiComponents(): boolean {
    for (const t of this._tools.values()) {
      if (t.config.ui) return true
    }
    for (const r of this._staticResources.values()) {
      if (r.config.ui || r.config.uri.startsWith('ui://')) return true
    }
    for (const r of this._templateResources.values()) {
      if (r.config.uri.startsWith('ui://')) return true
    }
    return false
  }

  /**
   * Create a new Server instance with all request handlers wired up.
   *
   * `modern` forks the advertised `resources.subscribe` capability. The legacy
   * `resources/subscribe`/`unsubscribe` RPCs are physically absent from the
   * 2026-07-28 wire registry (a modern client uses `subscriptions/listen`
   * instead), so a modern-only factory (the createMcpHandler path) must NOT
   * advertise `subscribe` — the modern `server/discover` document is pinned to
   * `resources: { listChanged: true }`. The primary in-process server and
   * legacy HTTP sessions are always legacy, so they always advertise it.
   * stdio forks it per-connection too: `run()`'s stdio branch reads the
   * `ctx.era` the SDK's `McpServerFactory` hook hands it (serveStdio only
   * calls the factory once the opening exchange has classified the era, so
   * the modern-vs-legacy choice is already known at construction time) and
   * passes it straight through as `opts.modern`.
   *
   * The `completions` capability is NOT era-forked: `completion/complete` is in
   * BOTH era wire registries (the legacy 2025-11-25 registry and the modern
   * 2026-07-28 `dispatchRequestSchemas`), and `completions` is a valid key in
   * both eras' ServerCapabilities schemas. So it is declared unconditionally —
   * unlike `subscribe`, there is no legacy-only surface to hide from a modern
   * client here, so nothing needs the era fork the way `subscribe` does. The
   * SDK also requires this capability to be present to register the
   * `completion/complete` handler (`assertRequestHandlerCapability`).
   */
  private _makeServer(sessionState?: Map<string, unknown>, opts?: { modern?: boolean }): Server {
    const state = sessionState ?? this._primaryState
    // mimeTypes announces what fastmcp can serve, symmetric with the mimeTypes the
    // client is required to declare on its own extension entry (SEP-1865).
    const extensions = this._hasUiComponents()
      ? { [UI_EXTENSION_KEY]: { mimeTypes: [UI_RESOURCE_MIME_TYPE] } }
      : undefined
    const server = new Server(
      { name: this.name, version: this.version },
      {
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true, ...(opts?.modern ? {} : { subscribe: true }) }, prompts: { listChanged: true }, logging: {}, completions: {}, ...(extensions ? { extensions } : {}) },
        ...(this._cacheHints ? { cacheHints: this._cacheHints } : {}),
        ...(this._requestStateCodec
          ? { requestState: { verify: this._requestStateCodec.verify.bind(this._requestStateCodec) } }
          : {}),
        ...(this._inputRequiredOptions ? { inputRequired: this._inputRequiredOptions } : {}),
      },
    )
    for (const mw of this._middleware) mw.setup?.(server)
    this._setupHandlers(server, state)
    return server
  }

  private async _resolveToken(authInfo: AuthInfo | undefined): Promise<AccessToken | undefined> {
    return toAccessToken(authInfo) ?? await resolveCliEnvToken(this._auth)
  }

  private _setupHandlers(server: Server, sessionState: Map<string, unknown>): void {
    server.setRequestHandler('tools/list', async (req, sdkCtx) => {
      const token = await this._resolveToken(sdkCtx.http?.authInfo)
      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)
      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'tools/list', req.params, ctx, async () => {
          const clientIsUiCapable = isUiCapable(server.getClientCapabilities())

          const allVisible = (
            await Promise.all(
              [...this._tools.values()].map(async (t) => {
                if (t.config.disabled) return null
                // App-only tools are hidden from listTools (visible only inside the iframe)
                if (t.config.ui?.visibility && !t.config.ui.visibility.includes('model')) return null
                if (!t.config.auth) return t
                if (!token) return null
                try { await t.config.auth(token); return t } catch { return null }
              }),
            )
          ).filter((t): t is RegisteredTool => t !== null)

          const transformedTools = this._applyTransformsToTools(allVisible)
          const { resourceViews, promptViews } = await this._getVisibleViews(token)
          const synthesized = this._buildSynthesizedTools(resourceViews, promptViews)

          type ListEntry =
            | { kind: 'registered'; name: string; title: string | undefined; description: string; config: ToolConfig }
            | { kind: 'synthesized'; name: string; title: string | undefined; description: string; inputSchema: Record<string, unknown> | undefined }

          const allEntries: ListEntry[] = [
            ...transformedTools.map(
              (t): ListEntry => ({ kind: 'registered', name: t.name, title: t.title, description: t.description, config: t.config }),
            ),
            ...synthesized.map(
              (s): ListEntry => ({ kind: 'synthesized', name: s.name, title: s.title, description: s.description, inputSchema: s.inputSchema }),
            ),
          ]

          const pageSize = this._toolsPageSize
          const cursorName = req.params?.cursor
            ? Buffer.from(req.params.cursor, 'base64url').toString()
            : null
          let startIdx = 0
          if (cursorName !== null) {
            const idx = allEntries.findIndex((e) => e.name === cursorName)
            if (idx < 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired cursor')
            startIdx = idx + 1
          }
          const page = allEntries.slice(startIdx, startIdx + pageSize)
          const nextCursor =
            startIdx + pageSize < allEntries.length
              ? Buffer.from(page[page.length - 1].name).toString('base64url')
              : undefined

          const tools = await Promise.all(
            page.map(async (entry) => {
              if (entry.kind === 'synthesized') {
                return {
                  name: entry.name,
                  ...(entry.title !== undefined ? { title: entry.title } : {}),
                  description: entry.description,
                  inputSchema: entry.inputSchema ?? { type: 'object' as const },
                }
              }
              const t = entry.config
              const inputSchema =
                t.inputSchema ??
                (t.input
                  ? await toJsonSchema(t.input, `tool "${t.name}" input`)
                  : { type: 'object' as const })
              const outputSchema =
                t.outputSchema ??
                (t.output
                  ? await toJsonSchema(t.output, `tool "${t.name}" output`)
                  : undefined)
              const uiMeta = clientIsUiCapable && t.ui
                ? {
                    resourceUri: t.ui.resourceUri ?? `ui://${t.name}`,
                    ...(t.ui.visibility ? { visibility: t.ui.visibility } : {}),
                  }
                : undefined
              return {
                name: entry.name,
                ...(entry.title !== undefined ? { title: entry.title } : {}),
                description: entry.description,
                inputSchema,
                ...(outputSchema ? { outputSchema } : {}),
                ...(uiMeta ? { _meta: { ui: uiMeta } } : {}),
              }
            }),
          )

          // Cast: our JSON Schema generation (toJsonSchema / user-supplied inputSchema) is
          // typed loosely as Record<string, unknown>, while the SDK's Tool type is inferred
          // from a strict Zod schema requiring a literal `type: 'object'` root. The generated
          // schemas satisfy this at runtime (see tool.ts); this is a static-typing gap only.
          return { tools, ...(nextCursor ? { nextCursor } : {}) } as ListToolsResult
        }),
      )
    })

    server.setRequestHandler('tools/call', async (req, sdkCtx) => {
      const requestedName = req.params.name
      const token = await this._resolveToken(sdkCtx.http?.authInfo)

      // Check synthesized tools first
      const { resourceViews, promptViews } = await this._getVisibleViews(token)
      const synthesizedList = this._buildSynthesizedTools(resourceViews, promptViews)
      const synthTool = synthesizedList.find((s) => s.name === requestedName)
      if (synthTool) {
        if (synthTool.auth) await runAuthCheck(synthTool.auth, token)
        const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)
        try {
          return await contextStore.run(ctx, () =>
            runMiddlewareChain(this._middleware, 'tools/call', req.params, ctx, async () => {
              let executePromise: Promise<unknown> = Promise.resolve(
                synthTool.handler(req.params.arguments ?? {}),
              )
              if (synthTool.timeout) {
                const ms = synthTool.timeout
                let timer!: ReturnType<typeof setTimeout>
                const timeoutPromise = new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error(`Tool "${requestedName}" timed out after ${ms}ms`)),
                    ms,
                  )
                })
                executePromise = Promise.race([executePromise, timeoutPromise]).finally(() =>
                  clearTimeout(timer),
                )
              }
              return convertResult(await executePromise)
            }),
          )
        } catch (err) {
          if (err instanceof ProtocolError) throw err
          return {
            content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }
        }
      }

      // Find by transformed name, then fall back to direct registry (for hidden/unaffected tools)
      let tool: RegisteredTool | undefined
      if (this._transforms.length > 0) {
        for (const t of this._tools.values()) {
          const view = applyTransformChain<ToolView>(
            { name: t.config.name, description: t.config.description, tags: t.config.tags ?? [] },
            this._transforms,
            (tr, v) => tr.transformTool?.(v),
          )
          if (view && view.name === requestedName) { tool = t; break }
        }
      }
      if (!tool) tool = this._tools.get(requestedName)

      if (!tool || tool.config.disabled) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: "${requestedName}"`)
      }

      if (tool.config.auth) await runAuthCheck(tool.config.auth, token)

      const resolvedTool = tool
      const rawArgs: unknown = req.params.arguments ?? {}
      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)

      try {
        return await contextStore.run(ctx, () =>
          runMiddlewareChain(this._middleware, 'tools/call', req.params, ctx, async () => {
            const args = resolvedTool.config.input ? await validateInput(resolvedTool.config.input, rawArgs, true) : rawArgs

            let executePromise: Promise<unknown> = Promise.resolve(resolvedTool.handler(args))

            if (resolvedTool.config.timeout) {
              const ms = resolvedTool.config.timeout
              let timer!: ReturnType<typeof setTimeout>
              const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`Tool "${requestedName}" timed out after ${ms}ms`)),
                  ms,
                )
              })
              executePromise = Promise.race([executePromise, timeoutPromise]).finally(() =>
                clearTimeout(timer),
              )
            }

            let resultValue = await executePromise
            if (resolvedTool.config.output) resultValue = await validateInput(resolvedTool.config.output, resultValue)
            const callResult = convertResult(resultValue)
            // Graceful degradation: strip structuredContent for non-UI clients calling UI tools
            if (resolvedTool.config.ui) {
              const clientIsUi = isUiCapable(server.getClientCapabilities())
              if (!clientIsUi && callResult.structuredContent !== undefined) {
                return { content: [{ type: 'text' as const, text: '[UI not available in this client]' }] }
              }
            }
            return callResult
          }),
        )
      } catch (err) {
        if (err instanceof ProtocolError) throw err
        return {
          content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        }
      }
    })

    server.setRequestHandler('resources/list', async (req, sdkCtx) => {
      const token = await this._resolveToken(sdkCtx.http?.authInfo)
      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)
      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'resources/list', req.params, ctx, async () => {
          const allVisible = (
            await Promise.all(
              [...this._staticResources.values()].map(async (r) => {
                if (r.config.disabled) return null
                if (!r.config.auth) return r
                if (!token) return null
                try { await r.config.auth(token); return r } catch { return null }
              }),
            )
          ).filter((r): r is RegisteredResource => r !== null)

          const transformedResources = this._applyTransformsToResources(allVisible)

          const pageSize = this._resourcesPageSize
          const cursorUri = req.params?.cursor
            ? Buffer.from(req.params.cursor, 'base64url').toString()
            : null
          let startIdx = 0
          if (cursorUri !== null) {
            const idx = transformedResources.findIndex((r) => r.uri === cursorUri)
            if (idx < 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired cursor')
            startIdx = idx + 1
          }
          const page = transformedResources.slice(startIdx, startIdx + pageSize)
          const nextCursor =
            startIdx + pageSize < transformedResources.length
              ? Buffer.from(page[page.length - 1].uri).toString('base64url')
              : undefined

          const clientIsUiCapableRes = isUiCapable(server.getClientCapabilities())
          return {
            resources: page.map((r) => ({
              uri: r.uri,
              name: r.name,
              ...(r.config.title !== undefined ? { title: r.config.title } : {}),
              ...(r.config.description !== undefined ? { description: r.config.description } : {}),
              ...(r.config.mimeType !== undefined ? { mimeType: r.config.mimeType } : {}),
              ...(r.config.size !== undefined ? { size: r.config.size } : {}),
              ...(r.config.annotations !== undefined ? { annotations: r.config.annotations } : {}),
              ...(clientIsUiCapableRes && r.config.ui ? { _meta: { ui: r.config.ui } } : {}),
            })),
            ...(nextCursor ? { nextCursor } : {}),
          }
        }),
      )
    })

    server.setRequestHandler('resources/templates/list', async (req, sdkCtx) => {
      const token = await this._resolveToken(sdkCtx.http?.authInfo)
      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)
      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'resources/templates/list', req.params, ctx, async () => {
          const allVisible = (
            await Promise.all(
              [...this._templateResources.values()].map(async (r) => {
                if (r.config.disabled) return null
                if (!r.config.auth) return r
                if (!token) return null
                try { await r.config.auth(token); return r } catch { return null }
              }),
            )
          ).filter((r): r is RegisteredResource => r !== null)

          const transformedTemplates = this._applyTransformsToResourceTemplates(allVisible)

          const pageSize = this._resourcesPageSize
          const cursorUri = req.params?.cursor
            ? Buffer.from(req.params.cursor, 'base64url').toString()
            : null
          let startIdx = 0
          if (cursorUri !== null) {
            const idx = transformedTemplates.findIndex((r) => r.uri === cursorUri)
            if (idx < 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired cursor')
            startIdx = idx + 1
          }
          const page = transformedTemplates.slice(startIdx, startIdx + pageSize)
          const nextCursor =
            startIdx + pageSize < transformedTemplates.length
              ? Buffer.from(page[page.length - 1].uri).toString('base64url')
              : undefined

          return {
            resourceTemplates: page.map((r) => ({
              uriTemplate: r.uri,
              name: r.name,
              ...(r.config.title !== undefined ? { title: r.config.title } : {}),
              ...(r.config.description !== undefined ? { description: r.config.description } : {}),
              ...(r.config.mimeType !== undefined ? { mimeType: r.config.mimeType } : {}),
              ...(r.config.annotations !== undefined ? { annotations: r.config.annotations } : {}),
            })),
            ...(nextCursor ? { nextCursor } : {}),
          }
        }),
      )
    })

    server.setRequestHandler('resources/read', async (req, sdkCtx) => {
      const requestedUri = req.params.uri
      const token = await this._resolveToken(sdkCtx.http?.authInfo)

      const resolved = this._resolveResource(requestedUri)
      if (!resolved || resolved.resource.config.disabled) {
        // ResourceNotFoundError stamps `data: { uri }` (exactly one key) and keeps the
        // -32602 code the SDK recognition contract requires, so a client can tell a
        // resource miss from a generic Invalid Params (task-9 Req 3; task-7 F1).
        throw new ResourceNotFoundError(requestedUri, `Unknown resource: "${requestedUri}"`)
      }
      const resource = resolved.resource
      const templateParams = resolved.templateParams

      if (resource.config.auth) await runAuthCheck(resource.config.auth, token)

      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)

      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'resources/read', req.params, ctx, async () => {
          let executePromise: Promise<unknown> = Promise.resolve(resource!.handler(templateParams))

          if (resource!.config.timeout) {
            const ms = resource!.config.timeout
            let timer!: ReturnType<typeof setTimeout>
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Resource "${requestedUri}" timed out after ${ms}ms`)),
                ms,
              )
            })
            executePromise = Promise.race([executePromise, timeoutPromise]).finally(() =>
              clearTimeout(timer),
            ) as Promise<unknown>
          }

          const result = await executePromise
          return convertResourceResult(result, requestedUri, resource!.config.mimeType)
        }),
      )
    })

    // resources/subscribe / resources/unsubscribe (legacy era only).
    //
    // The 2026-07-28 wire registry omits both methods, so a modern connection
    // never reaches these handlers — the SDK rejects the method at the era seam
    // (-32601) before dispatch, and a modern client's own era guard rejects even
    // earlier. On legacy the handshake advertises `resources.subscribe: true`
    // (see _makeServer), so the client may call them here.
    //
    // The subscription set lives in the connection's per-session state Map (the
    // same Map SESSION_CLOSE_CALLBACKS_KEY uses), so it is discarded when the
    // session closes — no separate registry to leak. Delivery of
    // `notifications/resources/updated` is driven by notifyResourceUpdated(uri),
    // the single change signal shared with the modern subscriptions/listen bus.
    //
    // Only resources/subscribe mirrors resources/read's resolve → not-found →
    // auth → context → middleware sequencing, so subscribe is indistinguishable
    // from read as an oracle. resources/unsubscribe skips resolution and auth: it
    // only removes uri from the caller's own subscription set, so an unknown or
    // forbidden uri is a harmless no-op, not an oracle — there is nothing to guard.
    server.setRequestHandler('resources/subscribe', async (req, sdkCtx) => {
      const uri = req.params.uri
      const token = await this._resolveToken(sdkCtx.http?.authInfo)

      // Resolve against the same lookup resources/read uses; an unknown or
      // disabled URI is a bad parameter (ResourceNotFoundError → -32602), matching
      // resources/read's not-found contract exactly.
      const resolved = this._resolveResource(uri)
      if (!resolved || resolved.resource.config.disabled) {
        throw new ResourceNotFoundError(uri, `Unknown resource: "${uri}"`)
      }
      const resource = resolved.resource

      // Enforce the resource's auth guard identically to resources/read (same
      // rejection). Without this, subscribe leaks an existence/activity oracle for a
      // URI that read (and resources/list) deliberately hides from an under-scoped
      // caller: `{}` for a real-but-forbidden URI vs -32602 for an unknown one.
      if (resource.config.auth) await runAuthCheck(resource.config.auth, token)

      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)

      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'resources/subscribe', req.params, ctx, async () => {
          let subs = sessionState.get(RESOURCE_SUBSCRIPTIONS_KEY) as Set<string> | undefined
          if (!subs) {
            subs = new Set<string>()
            sessionState.set(RESOURCE_SUBSCRIPTIONS_KEY, subs)
          }
          subs.add(uri)
          return {}
        }),
      )
    })

    server.setRequestHandler('resources/unsubscribe', async (req, sdkCtx) => {
      const uri = req.params.uri
      const token = await this._resolveToken(sdkCtx.http?.authInfo)
      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)

      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'resources/unsubscribe', req.params, ctx, async () => {
          const subs = sessionState.get(RESOURCE_SUBSCRIPTIONS_KEY) as Set<string> | undefined
          subs?.delete(uri)
          return {}
        }),
      )
    })

    server.setRequestHandler('prompts/list', async (req, sdkCtx) => {
      const token = await this._resolveToken(sdkCtx.http?.authInfo)
      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)
      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'prompts/list', req.params, ctx, async () => {
          const allVisible = (
            await Promise.all(
              [...this._prompts.values()].map(async (p) => {
                if (p.config.disabled) return null
                if (!p.config.auth) return p
                if (!token) return null
                try { await p.config.auth(token); return p } catch { return null }
              }),
            )
          ).filter((p): p is RegisteredPrompt => p !== null)

          const transformedPrompts = this._applyTransformsToPrompts(allVisible)

          const pageSize = this._promptsPageSize
          const cursorName = req.params?.cursor
            ? Buffer.from(req.params.cursor, 'base64url').toString()
            : null
          let startIdx = 0
          if (cursorName !== null) {
            const idx = transformedPrompts.findIndex((p) => p.name === cursorName)
            if (idx < 0) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired cursor')
            startIdx = idx + 1
          }
          const page = transformedPrompts.slice(startIdx, startIdx + pageSize)
          const nextCursor =
            startIdx + pageSize < transformedPrompts.length
              ? Buffer.from(page[page.length - 1].name).toString('base64url')
              : undefined

          return {
            prompts: page.map((p) => ({
              name: p.name,
              ...(p.config.title !== undefined ? { title: p.config.title } : {}),
              description: p.description,
              // Strip the per-argument `complete` callback — it is a server-side
              // completion hook, not part of the advertised argument schema.
              ...(p.config.arguments?.length
                ? {
                    arguments: p.config.arguments.map((a) => ({
                      name: a.name,
                      ...(a.description !== undefined ? { description: a.description } : {}),
                      ...(a.required !== undefined ? { required: a.required } : {}),
                    })),
                  }
                : {}),
            })),
            ...(nextCursor ? { nextCursor } : {}),
          }
        }),
      )
    })

    server.setRequestHandler('prompts/get', async (req, sdkCtx) => {
      const requestedName = req.params.name
      let prompt: RegisteredPrompt | undefined
      if (this._transforms.length > 0) {
        for (const p of this._prompts.values()) {
          const view = applyTransformChain<PromptView>(
            { name: p.config.name, description: p.config.description, tags: p.config.tags ?? [] },
            this._transforms,
            (t, v) => t.transformPrompt?.(v),
          )
          if (view && view.name === requestedName) { prompt = p; break }
        }
      }
      if (!prompt) prompt = this._prompts.get(requestedName)

      if (!prompt || prompt.config.disabled) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: "${requestedName}"`)
      }

      const resolvedPrompt = prompt
      const token = await this._resolveToken(sdkCtx.http?.authInfo)
      if (resolvedPrompt.config.auth) await runAuthCheck(resolvedPrompt.config.auth, token)

      const suppliedArgs = req.params.arguments ?? {}
      for (const arg of resolvedPrompt.config.arguments ?? []) {
        if (arg.required && !(arg.name in suppliedArgs)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Missing required argument "${arg.name}" for prompt "${requestedName}"`,
          )
        }
      }

      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)

      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'prompts/get', req.params, ctx, async () => {
          let executePromise = Promise.resolve(resolvedPrompt.handler(suppliedArgs))
          if (resolvedPrompt.config.timeout) {
            const ms = resolvedPrompt.config.timeout
            let timer!: ReturnType<typeof setTimeout>
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Prompt "${requestedName}" timed out after ${ms}ms`)),
                ms,
              )
            })
            executePromise = Promise.race([executePromise, timeoutPromise]).finally(() =>
              clearTimeout(timer),
            )
          }
          // Cast: the SDK infers the handler's return type as GetPromptResult |
          // InputRequiredResult (multi-round-trip); this handler only returns the
          // "complete" shape today. inputRequired(...) support lands separately.
          return convertPromptResult(await executePromise) as GetPromptResult
        }),
      )
    })

    // completion/complete — argument autocompletion for prompt arguments and
    // resource-template variables. Registered on every factory (both eras admit
    // the method; see _makeServer's `completions` capability note). Routes by the
    // request's ref type using the SDK's assert helpers (which narrow the request
    // after the `ref.type` switch has already established the branch), then
    // dispatches to _completePrompt / _completeResourceTemplate. Both mirror
    // prompts/get and resources/read: resolve → not-found (-32602) → auth → run,
    // so completion is no weaker an oracle than get/read and audit middleware
    // observes it.
    server.setRequestHandler('completion/complete', async (req, sdkCtx) => {
      const token = await this._resolveToken(sdkCtx.http?.authInfo)
      const ctx = createContext(server, sdkCtx, token, sessionState, this._requestStateCodec)
      return contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'completion/complete', req.params, ctx, async () => {
          const ref = req.params.ref
          if (ref.type === 'ref/prompt') {
            assertCompleteRequestPrompt(req)
            return this._completePrompt(req.params, token)
          }
          if (ref.type === 'ref/resource') {
            assertCompleteRequestResourceTemplate(req)
            return this._completeResourceTemplate(req.params, token)
          }
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Invalid completion reference type: "${(ref as { type: string }).type}"`,
          )
        }),
      )
    })
  }

  /**
   * Resolve a `completion/complete` request against a prompt argument's completer.
   * Mirrors prompts/get's transform-aware lookup, not-found contract (-32602), and
   * auth check; an argument with no completer yields an empty list (SDK parity).
   */
  private async _completePrompt(
    params: CompleteRequestParams,
    token: AccessToken | undefined,
  ): Promise<CompleteResult> {
    const ref = params.ref as { type: 'ref/prompt'; name: string }
    let prompt: RegisteredPrompt | undefined
    if (this._transforms.length > 0) {
      for (const p of this._prompts.values()) {
        const view = applyTransformChain<PromptView>(
          { name: p.config.name, description: p.config.description, tags: p.config.tags ?? [] },
          this._transforms,
          (t, v) => t.transformPrompt?.(v),
        )
        if (view && view.name === ref.name) { prompt = p; break }
      }
    }
    if (!prompt) prompt = this._prompts.get(ref.name)

    if (!prompt || prompt.config.disabled) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: "${ref.name}"`)
    }
    if (prompt.config.auth) await runAuthCheck(prompt.config.auth, token)

    const arg = prompt.config.arguments?.find((a) => a.name === params.argument.name)
    if (!arg?.complete) return { completion: EMPTY_COMPLETION }

    const raw = await arg.complete(params.argument.value, params.context)
    return { completion: normalizeCompletion(raw) }
  }

  /**
   * Resolve a `completion/complete` request against a resource template's
   * per-variable completer. Mirrors resources/read's not-found contract (-32602)
   * and auth check; a variable with no completer yields an empty list. Following
   * the SDK's own high-level server, a `ref.uri` that names a registered STATIC
   * resource (not a template) is answered with an empty list rather than an error.
   */
  private async _completeResourceTemplate(
    params: CompleteRequestParams,
    token: AccessToken | undefined,
  ): Promise<CompleteResult> {
    const ref = params.ref as { type: 'ref/resource'; uri: string }
    let template = this._templateResources.get(ref.uri)
    if (!template && this._transforms.length > 0) {
      for (const r of this._templateResources.values()) {
        const view = applyTransformChain<ResourceView>(
          { uri: r.config.uri, name: r.config.name ?? r.config.uri, tags: r.config.tags ?? [], mimeType: r.config.mimeType, title: r.config.title },
          this._transforms,
          (t, v) => t.transformResourceTemplate?.(v),
        )
        if (view && view.uri === ref.uri) { template = r; break }
      }
    }

    if (!template || template.config.disabled) {
      // A concrete (non-template) resource URI is a valid ref with nothing to
      // complete — answer empty, matching the SDK's high-level server. But apply
      // resources/read's resolve → not-found → auth gate first, so a disabled or
      // auth-gated static resource is NOT an existence oracle: a hidden resource
      // must be indistinguishable from an unknown URI (task-11's subscribe standard).
      const staticResource = this._staticResources.get(ref.uri)
      if (staticResource && !staticResource.config.disabled) {
        // Enforce the resource's auth guard identically to resources/read (same
        // rejection). Without this, an auth-gated static resource answers `{}` here
        // while read rejects it — a caller could enumerate forbidden URIs.
        if (staticResource.config.auth) await runAuthCheck(staticResource.config.auth, token)
        return { completion: EMPTY_COMPLETION }
      }
      // Disabled or unknown: fall through to the identical not-found rejection, so a
      // disabled static resource is byte-indistinguishable from a URI that was never
      // registered (matches read's not-found code, -32602).
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown resource template: "${ref.uri}"`)
    }
    if (template.config.auth) await runAuthCheck(template.config.auth, token)

    const completer = template.config.complete?.[params.argument.name]
    if (!completer) return { completion: EMPTY_COMPLETION }

    const raw = await completer(params.argument.value, params.context)
    return { completion: normalizeCompletion(raw) }
  }

  private _notifyToolListChanged(): void {
    this._primaryServer.sendToolListChanged().catch(() => {})
    this._stdioServer?.sendToolListChanged().catch(() => {})
    for (const { server } of this._sessions.values()) {
      server.sendToolListChanged().catch(() => {})
    }
    // Modern (2026-07-28) HTTP requests are stateless per-request — there is no live
    // connection to push an unsolicited notification to. Delivery for subscribed
    // modern clients instead goes through the shared modern handler's own
    // subscriptions/listen bus (see _getModernHandler / FastMCPOptions.eventBus).
    // Optional chaining: a no-op until the first modern HTTP request creates the
    // handler — nothing to notify before then, so there is no reason to force it
    // into existence just to publish to an empty bus.
    this._modernHandler?.notify.toolsChanged()
  }

  private _notifyResourceListChanged(): void {
    this._primaryServer.sendResourceListChanged().catch(() => {})
    this._stdioServer?.sendResourceListChanged().catch(() => {})
    for (const { server } of this._sessions.values()) {
      server.sendResourceListChanged().catch(() => {})
    }
    this._modernHandler?.notify.resourcesChanged()
  }

  private _notifyPromptListChanged(): void {
    this._primaryServer.sendPromptListChanged().catch(() => {})
    this._stdioServer?.sendPromptListChanged().catch(() => {})
    for (const { server } of this._sessions.values()) {
      server.sendPromptListChanged().catch(() => {})
    }
    this._modernHandler?.notify.promptsChanged()
  }

  /**
   * Signal that a resource changed and any subscriber should re-read it. This is
   * the SINGLE change signal for resource updates across both eras — the legacy
   * per-session push and the modern subscriptions/listen bus are driven from here:
   *
   * - Legacy connections (primary / stdio / legacy HTTP sessions) that called
   *   `resources/subscribe` for `uri` are pushed `notifications/resources/updated`
   *   directly on their live session (subscription set kept in per-session state).
   * - The modern handler's bus (W3) is published to as well; it does its own
   *   per-stream filtering, delivering only to `subscriptions/listen` streams that
   *   opted in to this URI. Optional chaining keeps it a no-op until the first
   *   modern HTTP request has actually built the handler.
   *
   * Unsubscribed sessions (and the modern streams that never opted in) receive
   * nothing, so calling this for a URI with no subscribers is safe and cheap.
   */
  notifyResourceUpdated(uri: string): void {
    const pushIfSubscribed = (server: Server, state: Map<string, unknown> | null): void => {
      const subs = state?.get(RESOURCE_SUBSCRIPTIONS_KEY) as Set<string> | undefined
      if (subs?.has(uri)) server.sendResourceUpdated({ uri }).catch(() => {})
    }
    pushIfSubscribed(this._primaryServer, this._primaryState)
    if (this._stdioServer) pushIfSubscribed(this._stdioServer, this._stdioState)
    for (const { server, state } of this._sessions.values()) pushIfSubscribed(server, state)
    this._modernHandler?.notify.resourceUpdated(uri)
  }

  /**
   * Resolve a requested URI to a registered resource, mirroring the lookup order
   * `resources/read` uses: exact static match, then original template match, then
   * (only when transforms are registered) transformed-static and
   * transformed-template matches. Returns the resource plus any template params, or
   * undefined when nothing matches. Disabled static resources are still returned by
   * exact match — callers apply the `disabled` check themselves (as read does), so
   * a hidden-but-known URI is a not-found, not a silent miss.
   */
  private _resolveResource(
    requestedUri: string,
  ): { resource: RegisteredResource; templateParams?: Record<string, string> } | undefined {
    let resource: RegisteredResource | undefined = this._staticResources.get(requestedUri)
    let templateParams: Record<string, string> | undefined

    // Direct template matching (original URIs — also handles hidden-but-callable resources)
    if (!resource) {
      for (const r of this._templateResources.values()) {
        if (r.config.disabled) continue
        const params = matchTemplate(r.config.uri, requestedUri)
        if (params !== null) { resource = r; templateParams = params; break }
      }
    }

    // Transformed static lookup
    if (!resource && this._transforms.length > 0) {
      for (const r of this._staticResources.values()) {
        if (r.config.disabled) continue
        const view = applyTransformChain<ResourceView>(
          { uri: r.config.uri, name: r.config.name ?? r.config.uri, tags: r.config.tags ?? [], mimeType: r.config.mimeType, title: r.config.title },
          this._transforms,
          (t, v) => t.transformResource?.(v),
        )
        if (view && view.uri === requestedUri) { resource = r; break }
      }
    }

    // Transformed template matching
    if (!resource && this._transforms.length > 0) {
      for (const r of this._templateResources.values()) {
        if (r.config.disabled) continue
        const view = applyTransformChain<ResourceView>(
          { uri: r.config.uri, name: r.config.name ?? r.config.uri, tags: r.config.tags ?? [], mimeType: r.config.mimeType, title: r.config.title },
          this._transforms,
          (t, v) => t.transformResourceTemplate?.(v),
        )
        if (view) {
          const params = matchTemplate(view.uri, requestedUri)
          if (params !== null) { resource = r; templateParams = params; break }
        }
      }
    }

    if (!resource) return undefined
    return { resource, templateParams }
  }

  // Overload: typed handler inferred from input schema
  tool<S extends StandardSchemaV1>(
    config: Omit<ToolConfig, 'input'> & { input: S },
    handler: (args: StandardSchemaV1.InferOutput<S>) => unknown,
  ): void
  // Overload: untyped handler
  tool(config: ToolConfig, handler: (args: Record<string, unknown>) => unknown): void
  // Implementation (handler typed as any to satisfy both overload signatures)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool(config: ToolConfig, handler: (args: any) => any): void {
    const registered: RegisteredTool = { config, handler }
    this._tools.set(config.name, registered)
    this._notifyToolListChanged()
    for (const cb of this._toolRegisteredCallbacks) cb(registered)
  }

  prompt(config: PromptConfig, handler: (args?: Record<string, string>) => unknown): void {
    const name = config.name ?? (handler as { name?: string }).name
    if (!name) throw new Error('Prompt name must be provided in config or inferrable from the handler function name')
    const description = config.description ?? inferDescription(name)
    const resolvedConfig: ResolvedPromptConfig = { ...config, name, description }
    const registered: RegisteredPrompt = { config: resolvedConfig, handler }
    this._prompts.set(name, registered)
    this._notifyPromptListChanged()
    for (const cb of this._promptRegisteredCallbacks) cb(registered)
  }

  resource(config: ResourceConfig, handler: (params?: Record<string, string>) => unknown): void {
    const registered: RegisteredResource = { config, handler }
    if (isUriTemplate(config.uri)) {
      this._templateResources.set(config.uri, registered)
    } else {
      this._staticResources.set(config.uri, registered)
    }
    this._notifyResourceListChanged()
    for (const cb of this._resourceRegisteredCallbacks) cb(registered)
  }

  _removeTool(name: string): boolean {
    if (!this._tools.has(name)) return false
    this._tools.delete(name)
    this._notifyToolListChanged()
    return true
  }

  _removeResource(uri: string): boolean {
    if (this._staticResources.has(uri)) {
      this._staticResources.delete(uri)
      this._notifyResourceListChanged()
      return true
    }
    if (this._templateResources.has(uri)) {
      this._templateResources.delete(uri)
      this._notifyResourceListChanged()
      return true
    }
    return false
  }

  _removePrompt(name: string): boolean {
    if (!this._prompts.has(name)) return false
    this._prompts.delete(name)
    this._notifyPromptListChanged()
    return true
  }

  /** Add a transform to the pipeline. Applied to list responses in registration order. */
  transform(t: Transform): this {
    this._transforms.push(t)
    return this
  }

  /**
   * Dispatch a tool call through this server's middleware chain using an inherited context.
   * Used by parent servers to honour child-level middleware when routing mounted tool calls.
   */
  async _dispatchTool(
    name: string,
    rawArgs: unknown,
    ctx: McpContext,
  ) {
    const tool = this._tools.get(name)
    if (!tool || tool.config.disabled) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: "${name}"`)
    }
    if (tool.config.auth) await runAuthCheck(tool.config.auth, ctx.auth)

    try {
      return await contextStore.run(ctx, () =>
        runMiddlewareChain(this._middleware, 'tools/call', { name, arguments: rawArgs }, ctx, async () => {
          const args = tool.config.input
            ? await validateInput(tool.config.input, rawArgs, true)
            : rawArgs

          let executePromise: Promise<unknown> = Promise.resolve(tool.handler(args))
          if (tool.config.timeout) {
            const ms = tool.config.timeout
            let timer!: ReturnType<typeof setTimeout>
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Tool "${name}" timed out after ${ms}ms`)),
                ms,
              )
            })
            executePromise = Promise.race([executePromise, timeoutPromise]).finally(() =>
              clearTimeout(timer),
            )
          }

          let resultValue = await executePromise
          if (tool.config.output) resultValue = await validateInput(tool.config.output, resultValue)
          return convertResult(resultValue)
        }),
      )
    } catch (err) {
      if (err instanceof ProtocolError) throw err
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      }
    }
  }

  /**
   * Run a resource read through this server's middleware chain using an inherited context.
   * Returns the raw handler result so the parent can apply convertResourceResult with the
   * actual requested URI (important for template resources).
   */
  async _dispatchResource(
    uri: string,
    params: Record<string, string> | undefined,
    ctx: McpContext,
  ): Promise<unknown> {
    const resource = isUriTemplate(uri)
      ? this._templateResources.get(uri)
      : this._staticResources.get(uri)

    if (!resource || resource.config.disabled) {
      // See resources/read handler: ResourceNotFoundError carries data.uri so the
      // miss is recognisable per the SDK contract (task-9 Req 3; task-7 F1).
      throw new ResourceNotFoundError(uri, `Unknown resource: "${uri}"`)
    }
    if (resource.config.auth) await runAuthCheck(resource.config.auth, ctx.auth)

    return contextStore.run(ctx, () =>
      runMiddlewareChain(this._middleware, 'resources/read', { uri }, ctx, async () => {
        let executePromise: Promise<unknown> = Promise.resolve(resource.handler(params))
        if (resource.config.timeout) {
          const ms = resource.config.timeout
          let timer!: ReturnType<typeof setTimeout>
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Resource "${uri}" timed out after ${ms}ms`)),
              ms,
            )
          })
          executePromise = Promise.race([executePromise, timeoutPromise]).finally(() =>
            clearTimeout(timer),
          ) as Promise<unknown>
        }
        return await executePromise
      }),
    )
  }

  /**
   * Dispatch a prompt render through this server's middleware chain using an inherited context.
   */
  async _dispatchPrompt(
    name: string,
    args: Record<string, string>,
    ctx: McpContext,
  ) {
    const prompt = this._prompts.get(name)
    if (!prompt || prompt.config.disabled) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: "${name}"`)
    }
    if (prompt.config.auth) await runAuthCheck(prompt.config.auth, ctx.auth)

    for (const arg of prompt.config.arguments ?? []) {
      if (arg.required && !(arg.name in args)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Missing required argument "${arg.name}" for prompt "${name}"`,
        )
      }
    }

    return contextStore.run(ctx, () =>
      runMiddlewareChain(this._middleware, 'prompts/get', { name, arguments: args }, ctx, async () => {
        let executePromise = Promise.resolve(prompt.handler(args))
        if (prompt.config.timeout) {
          const ms = prompt.config.timeout
          let timer!: ReturnType<typeof setTimeout>
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Prompt "${name}" timed out after ${ms}ms`)),
              ms,
            )
          })
          executePromise = Promise.race([executePromise, timeoutPromise]).finally(() =>
            clearTimeout(timer),
          )
        }
        return convertPromptResult(await executePromise)
      }),
    )
  }

  private _mirrorTool(child: FastMCP, tool: RegisteredTool, prefix?: string): void {
    const originalName = tool.config.name
    const key = prefix ? `${prefix}_${originalName}` : originalName
    if (this._tools.has(key)) throw new Error(`Tool name collision on mount: "${key}" is already registered`)
    // Strip runtime validators — child's _dispatchTool runs them.
    // inputSchema/outputSchema are kept so clients see the correct JSON Schema.
    const forwardedConfig: ToolConfig = { ...tool.config, name: key, input: undefined, output: undefined }
    this.tool(forwardedConfig, (args: unknown) => {
      const parentCtx = contextStore.getStore()!
      // Inject prefix-aware tool name resolver so toolRef() inside the child resolves correctly.
      const childCtx: typeof parentCtx = prefix
        ? { ...parentCtx, resolveToolName: (name) => `${prefix}_${name}` }
        : parentCtx
      // _dispatchTool already ran the child's own convertResult, so its resolved
      // value is either a finished CallToolResult (wrap in ToolResult so the parent's
      // own convertResult passes it through unchanged) or an InputRequiredResult
      // (multi-round-trip escape hatch — already recognized directly by convertResult,
      // must not be wrapped).
      return child._dispatchTool(originalName, args, childCtx).then((result) =>
        isInputRequiredResult(result) ? result : new ToolResult(result),
      )
    })
  }

  private _mirrorResource(child: FastMCP, resource: RegisteredResource, prefix?: string): void {
    const name = resource.config.name ?? resource.config.uri
    const originalUri = resource.config.uri
    const targetUri = prefix ? prefixResourceUri(originalUri, prefix) : originalUri
    if (this._staticResources.has(targetUri) || this._templateResources.has(targetUri)) {
      throw new Error(`Resource URI collision on mount: "${targetUri}" is already registered`)
    }
    const forwardedConfig: ResourceConfig = {
      ...resource.config,
      uri: targetUri,
      name: prefix ? `${prefix}_${name}` : name,
    }
    // Return the raw handler result so the parent's ReadResource handler can call
    // convertResourceResult with the actual requested URI (correct for template expansions).
    this.resource(forwardedConfig, (params?: Record<string, string>) => {
      const ctx = contextStore.getStore()!
      return child._dispatchResource(originalUri, params, ctx)
    })
  }

  private _mirrorPrompt(child: FastMCP, prompt: RegisteredPrompt, prefix?: string): void {
    const originalName = prompt.config.name
    const key = prefix ? `${prefix}_${originalName}` : originalName
    if (this._prompts.has(key)) throw new Error(`Prompt name collision on mount: "${key}" is already registered`)
    const forwardedConfig: PromptConfig = { ...(prompt.config as PromptConfig), name: key }
    this.prompt(forwardedConfig, (args?: Record<string, string>) => {
      const ctx = contextStore.getStore()!
      return child._dispatchPrompt(originalName, args ?? {}, ctx).then((result) =>
        isInputRequiredResult(result) ? result : new PromptResult(result.messages, result.description),
      )
    })
  }

  /** Mount a child server onto this server. All tools, resources, and prompts from the child become accessible via this server. Pass a prefix to namespace names and prevent collisions. */
  mount(child: FastMCP, prefix?: string): this {
    if (child === this) throw new Error('Cannot mount a server onto itself')
    if (this._mountedChildren.has(child)) return this
    this._mountedChildren.add(child)

    for (const tool of child._tools.values()) this._mirrorTool(child, tool, prefix)
    for (const resource of child._staticResources.values()) this._mirrorResource(child, resource, prefix)
    for (const resource of child._templateResources.values()) this._mirrorResource(child, resource, prefix)
    for (const prompt of child._prompts.values()) this._mirrorPrompt(child, prompt, prefix)

    child._toolRegisteredCallbacks.push((tool) => this._mirrorTool(child, tool, prefix))
    child._resourceRegisteredCallbacks.push((resource) => this._mirrorResource(child, resource, prefix))
    child._promptRegisteredCallbacks.push((prompt) => this._mirrorPrompt(child, prompt, prefix))

    // When this server closes, drain the child's owned proxy connections
    this._proxyCloseCallbacks.push(async () => {
      await Promise.all(child._proxyCloseCallbacks.map((cb) => cb().catch(() => {})))
      child._proxyCloseCallbacks.length = 0
    })

    return this
  }

  /** Register a callback invoked when this server is closed — used by proxy connections. */
  _addCloseCallback(cb: () => Promise<void>): void {
    this._proxyCloseCallbacks.push(cb)
  }

  /**
   * Register a provider (FastMCPApp or FastMCP) on this server.
   * All tools, resources, and prompts from the provider are mounted without a prefix.
   * For FastMCPApp, pass provider.server; for FastMCP, pass directly.
   */
  addProvider(provider: FastMCP | { server: FastMCP }): this {
    const child = 'server' in provider ? provider.server : provider
    return this.mount(child)
  }

  private _applyTransformsToTools(
    tools: RegisteredTool[],
  ): Array<{ name: string; title: string | undefined; description: string; originalName: string; config: ToolConfig; handler: (args: unknown) => unknown }> {
    return tools.flatMap((tool) => {
      const view = applyTransformChain<ToolView>(
        { name: tool.config.name, title: tool.config.title, description: tool.config.description, tags: tool.config.tags ?? [] },
        this._transforms,
        (t, v) => t.transformTool?.(v),
      )
      return view
        ? [{ name: view.name, title: view.title, description: view.description, originalName: tool.config.name, config: tool.config, handler: tool.handler }]
        : []
    })
  }

  private _applyTransformsToResources(
    resources: RegisteredResource[],
  ): Array<{ uri: string; name: string; originalUri: string; config: ResourceConfig; handler: (params?: Record<string, string>) => unknown }> {
    return resources.flatMap((r) => {
      const resolvedName = r.config.name ?? r.config.uri
      const view = applyTransformChain<ResourceView>(
        { uri: r.config.uri, name: resolvedName, tags: r.config.tags ?? [], mimeType: r.config.mimeType, title: r.config.title },
        this._transforms,
        (t, v) => t.transformResource?.(v),
      )
      return view
        ? [{ uri: view.uri, name: view.name, originalUri: r.config.uri, config: r.config, handler: r.handler }]
        : []
    })
  }

  private _applyTransformsToResourceTemplates(
    templates: RegisteredResource[],
  ): Array<{ uri: string; name: string; originalUri: string; config: ResourceConfig; handler: (params?: Record<string, string>) => unknown }> {
    return templates.flatMap((r) => {
      const resolvedName = r.config.name ?? r.config.uri
      const view = applyTransformChain<ResourceView>(
        { uri: r.config.uri, name: resolvedName, tags: r.config.tags ?? [], mimeType: r.config.mimeType, title: r.config.title },
        this._transforms,
        (t, v) => t.transformResourceTemplate?.(v),
      )
      return view
        ? [{ uri: view.uri, name: view.name, originalUri: r.config.uri, config: r.config, handler: r.handler }]
        : []
    })
  }

  private _applyTransformsToPrompts(
    prompts: RegisteredPrompt[],
  ): Array<{ name: string; description: string; originalName: string; config: ResolvedPromptConfig; handler: (args?: Record<string, string>) => unknown }> {
    return prompts.flatMap((p) => {
      const view = applyTransformChain<PromptView>(
        { name: p.config.name, description: p.config.description, tags: p.config.tags ?? [] },
        this._transforms,
        (t, v) => t.transformPrompt?.(v),
      )
      return view
        ? [{ name: view.name, description: view.description, originalName: p.config.name, config: p.config, handler: p.handler }]
        : []
    })
  }

  private _buildSynthesizedTools(resourceViews: ResourceView[], promptViews: PromptView[]): SynthesizedTool[] {
    if (this._transforms.length === 0) return []
    const raw = this._transforms.flatMap((t) => t.synthesizeTools?.(resourceViews, promptViews) ?? [])
    return raw.flatMap((s) => {
      const view = applyTransformChain<ToolView>(
        { name: s.name, title: s.title, description: s.description, tags: [] },
        this._transforms,
        (t, v) => t.transformTool?.(v),
      )
      return view ? [{ ...s, name: view.name, title: view.title, description: view.description }] : []
    })
  }

  private async _getVisibleViews(
    token: AccessToken | undefined,
  ): Promise<{ resourceViews: ResourceView[]; promptViews: PromptView[] }> {
    const visibleStatic = (
      await Promise.all(
        [...this._staticResources.values()].map(async (r) => {
          if (r.config.disabled) return null
          if (!r.config.auth) return r
          if (!token) return null
          try { await r.config.auth(token); return r } catch { return null }
        }),
      )
    ).filter((r): r is RegisteredResource => r !== null)

    const visibleTemplates = (
      await Promise.all(
        [...this._templateResources.values()].map(async (r) => {
          if (r.config.disabled) return null
          if (!r.config.auth) return r
          if (!token) return null
          try { await r.config.auth(token); return r } catch { return null }
        }),
      )
    ).filter((r): r is RegisteredResource => r !== null)

    const visiblePrompts = (
      await Promise.all(
        [...this._prompts.values()].map(async (p) => {
          if (p.config.disabled) return null
          if (!p.config.auth) return p
          if (!token) return null
          try { await p.config.auth(token); return p } catch { return null }
        }),
      )
    ).filter((p): p is RegisteredPrompt => p !== null)

    const resourceViews: ResourceView[] = [
      ...this._applyTransformsToResources(visibleStatic),
      ...this._applyTransformsToResourceTemplates(visibleTemplates),
    ].map((r) => ({
      uri: r.uri,
      name: r.name,
      tags: r.config.tags ?? [],
      mimeType: r.config.mimeType,
      title: r.config.title,
    }))

    const promptViews: PromptView[] = this._applyTransformsToPrompts(visiblePrompts).map((p) => ({
      name: p.name,
      description: p.description,
      tags: p.config.tags ?? [],
    }))

    return { resourceViews, promptViews }
  }

  /**
   * Add a middleware to the pipeline.
   *
   * Can be called at any point before the first request arrives. `setup()` is
   * called immediately on the primary server so that notification handlers and
   * other server-level side-effects are active before `connect()` / `run()` is
   * called. HTTP sessions created after `use()` will also have `setup()` called
   * via `_makeServer()`.
   */
  use(mw: Middleware): this {
    this._middleware.push(mw)
    mw.setup?.(this._primaryServer)
    return this
  }

  getContext(): McpContext {
    const ctx = contextStore.getStore()
    if (!ctx) throw new Error('getContext() called outside of a request handler')
    return ctx
  }

  /** The bound address after run() resolves for the http transport. Null for stdio or before run(). */
  get address(): ServerAddress | null {
    return this._address
  }

  /**
   * Whether `run()` or `connect()` has been called on this instance. Used by the
   * CLI's entrypoint loader to detect servers that already started themselves via
   * top-level code, so it doesn't attempt to start them a second time.
   */
  get isRunning(): boolean {
    return this._isRunning
  }

  async connect(transport: Transport): Promise<void> {
    this._isRunning = true
    // Rebuild so UI extension capability reflects all registered components.
    this._primaryServer = this._makeServer()
    await this._primaryServer.connect(transport)
  }

  /**
   * Modern-era (2026-07-28) in-process fetch entrypoint — the `McpServerLike`
   * duck-type hook `fastmcp-ts/client`'s `Client` looks for when a caller pins
   * modern era for an in-process server (`versionNegotiation: { mode: { pin:
   * '2026-07-28' } } }`). Delegates directly to the same `createMcpHandler`
   * instance the real HTTP modern path uses (`_getModernHandler`), so this is
   * the identical dispatch a real network connection would get — no sockets,
   * same code. Modern-only (`legacy: 'reject'`): a client using `'auto'` or
   * `'legacy'` negotiation instead goes through `connect()` + `InMemoryTransport`
   * (2025-era only), unaffected by this method.
   */
  async _modernFetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
    return this._getModernHandler().fetch(request, options)
  }

  async run(options?: RunOptions): Promise<void> {
    this._isRunning = true
    const rawTransport = process.env.MCP_TRANSPORT ?? options?.transport ?? 'stdio'
    if (rawTransport !== 'stdio' && rawTransport !== 'http') {
      throw new Error(`Unknown transport: "${rawTransport}". Supported: stdio, http.`)
    }
    const transport = rawTransport as 'stdio' | 'http'

    const port = options?.port ?? parseInt(process.env.MCP_PORT ?? process.env.PORT ?? '3000', 10)
    const host = options?.host ?? process.env.MCP_HOST ?? '127.0.0.1'
    const path = options?.path ?? process.env.MCP_PATH ?? '/mcp'

    if (transport === 'stdio') {
      const { StdioServerTransport, serveStdio } = await import('@modelcontextprotocol/server/stdio')
      const stdioTransport = new StdioServerTransport(options?.stdin, options?.stdout)
      // serveStdio owns the connection's era decision (from the opening exchange) and
      // pins one instance from the factory for the connection's lifetime — unlike
      // connect(), which is always 2025-era (used by in-process/test transports).
      // The factory may be invoked twice (a discarded server/discover probe instance,
      // then the real pinned one); _stdioServer always ends up holding the latter.
      // The factory receives `ctx.era` because serveStdio always classifies the
      // opening exchange's era before constructing an instance for it (including
      // the discarded probe instance, which is itself a modern-era construction) —
      // so `ctx.era` is used to fork `_makeServer`'s `modern` option the same way
      // `_getModernHandler` does, and a modern connection no longer advertises the
      // legacy-only `resources.subscribe` capability.
      this._stdioHandle = serveStdio(
        (ctx) => {
          // Capture the state Map so the resource-updated fan-out can reach this
          // connection's per-session subscription set (see _notifyResourceUpdated).
          const stdioState = new Map<string, unknown>()
          this._stdioState = stdioState
          this._stdioServer = this._makeServer(stdioState, { modern: ctx.era === 'modern' })
          return this._stdioServer
        },
        { transport: stdioTransport },
      )
    } else if (this._oauth) {
      await this._runHttpOAuth(port, host, path)
    } else {
      await this._runHttpSimple(port, host, path)
    }
  }

  /** Lazily builds the modern (2026-07-28) HTTP handler. One per FastMCP instance;
   * builds a fresh Server (via _makeServer) per request, matching createMcpHandler's
   * per-request-factory model. Modern-only (legacy: 'reject') — legacy (2025-era)
   * traffic is routed to the existing sessionful transport by _dispatchHttp instead
   * of createMcpHandler's own stateless legacy fallback, so session state and the
   * legacy server-initiated-request shim keep working for 2025-era clients. */
  private _getModernHandler(): McpHttpHandler {
    if (!this._modernHandler) {
      this._modernHandler = createMcpHandler(() => this._makeServer(new Map(), { modern: true }), {
        legacy: 'reject',
        ...(this._eventBus ? { bus: this._eventBus } : {}),
      })
    }
    return this._modernHandler
  }

  /**
   * Dual-era HTTP dispatch shared by the OAuth and non-OAuth serve paths. Assumes CORS
   * and auth have already been handled by the caller (req.auth already set, if any —
   * both the legacy transport and the modern handler read it as pass-through authInfo).
   */
  private async _dispatchHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding protection runs first and is header-only, so it never reads the
    // request body — no contention with the body parsing the legacy/modern branches do
    // below. Each guard writes the SDK's 403 JSON-RPC rejection and returns false when it
    // rejects, covering BOTH the legacy sessionful transport and the modern
    // createMcpHandler path from this one shared choke point.
    if (this._hostGuard && !this._hostGuard(req, res)) return
    if (this._originGuard && !this._originGuard(req, res)) return

    const { toNodeHandler, toWebRequest } = await import('@modelcontextprotocol/node')

    // Drains the raw Node req stream and builds a web-standard Request from the
    // buffered bytes; req cannot be re-read as a stream after this.
    const request = await toWebRequest(req)

    if (req.method === 'POST' && !isJsonContentType(request.headers.get('content-type'))) {
      res
        .writeHead(415, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'Unsupported Media Type: expected application/json' }))
      return
    }

    // No parsedBody passed here, so isLegacyRequest reads from an internal clone —
    // `request` itself stays fully unread, so we can still read its body below.
    const legacy = await isLegacyRequest(request)

    const parsedBody = req.method === 'POST' ? await request.json().catch(() => undefined) : undefined

    if (legacy) {
      await this._dispatchLegacyHttp(req, res, parsedBody)
    } else {
      await toNodeHandler(this._getModernHandler())(req, res, parsedBody)
    }
  }

  /** Existing sessionful Streamable HTTP handling for 2025-era clients — unchanged
   * behavior from before the dual-era split, just shared between the OAuth and
   * non-OAuth serve paths instead of duplicated. */
  private async _dispatchLegacyHttp(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    const { NodeStreamableHTTPServerTransport } = await import('@modelcontextprotocol/node')
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let mcpTransport: NodeStreamableHTTPServerTransport

    if (sessionId) {
      const existing = this._sessions.get(sessionId)
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Session not found' }))
        return
      }
      mcpTransport = existing.transport
    } else {
      const sessionState = new Map<string, unknown>()
      const sessionServer = this._makeServer(sessionState)
      mcpTransport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // SEP-1699 SSE resumability: a bounded per-session event store makes the
        // transport prime each 2025-11-25+ POST SSE stream with an `id`+empty-`data`
        // event (a Last-Event-ID resume anchor) and a `retry` hint, and lets a client
        // replay missed events after reconnecting. Retention is bounded (see
        // BoundedEventStore); the store is discarded with the session on close.
        eventStore: new BoundedEventStore(),
        retryInterval: LEGACY_SSE_RETRY_MS,
        onsessioninitialized: (id) => {
          this._sessions.set(id, { transport: mcpTransport, server: sessionServer, state: sessionState })
        },
        onsessionclosed: (id) => {
          const session = this._sessions.get(id)
          if (session) {
            const callbacks = (session.state.get(SESSION_CLOSE_CALLBACKS_KEY) as Array<() => void> | undefined) ?? []
            for (const cb of callbacks) cb()
          }
          this._sessions.delete(id)
        },
      })
      await sessionServer.connect(mcpTransport)
    }

    await mcpTransport.handleRequest(req, res, parsedBody)
  }

  /**
   * Resolve the DNS-rebinding Host/Origin guards for this serve from
   * `FastMCPOptions.dnsRebinding` and the bind `host`. Sets `_hostGuard` / `_originGuard`
   * (null = protection off). See the `dnsRebinding` option doc for the default posture.
   */
  private _resolveDnsRebindingGuards(host: string): void {
    const opt = this._dnsRebindingOptions
    // No config at all + a routable bind = open by default. Warn once so the operator
    // knows the posture; an explicit dnsRebinding (any shape) means they chose it.
    if (opt === undefined && !isLoopbackHost(host) && !_dnsRebindingWarned) {
      _dnsRebindingWarned = true
      console.warn(
        '[fastmcp] This HTTP server accepts requests from any Host or Origin. ' +
          'Set dnsRebinding in FastMCPOptions to protect local deployments against DNS rebinding.',
      )
    }
    const hasExplicitAllowlist = opt?.allowedHosts !== undefined || opt?.allowedOrigins !== undefined
    // Explicit `enabled` wins; otherwise supplying an allowlist, or binding a loopback
    // host, turns protection on. A routable bind with no config stays off (see option doc).
    const enabled = opt?.enabled ?? (hasExplicitAllowlist || isLoopbackHost(host))
    if (!enabled) {
      this._hostGuard = null
      this._originGuard = null
      return
    }
    this._hostGuard = hostHeaderValidation(opt?.allowedHosts ?? localhostAllowedHostnames())
    this._originGuard = originValidation(opt?.allowedOrigins ?? localhostAllowedOrigins())
  }

  private async _runHttpOAuth(port: number, host: string, path: string): Promise<void> {
    this._resolveDnsRebindingGuards(host)
    const express = (await import('express')).default
    const { mcpAuthRouter } = await import('@modelcontextprotocol/server-legacy/auth')
    const { requireBearerAuth } = await import(
      '@modelcontextprotocol/server-legacy/auth'
    )

    const oauth = this._oauth!
    const app = express()

    // Bind first so we can infer the issuerUrl from the actual bound port (handles port=0)
    const httpServer = await new Promise<HttpServer>((resolve, reject) => {
      const srv = app.listen(port, host, () => resolve(srv))
      srv.on('error', reject)
    })

    const bound = httpServer.address() as AddressInfo
    const issuerUrl = oauth.issuerUrl ?? new URL(`http://${bound.address}:${bound.port}`)

    // OAuth endpoints (authorize, token, register, metadata)
    app.use(
      mcpAuthRouter({
        provider: oauth.provider,
        issuerUrl,
        scopesSupported: oauth.scopes,
      }),
    )

    // MCP endpoint — protected by bearer auth; requireBearerAuth sets req.auth, which
    // both the legacy transport and the modern handler read as pass-through authInfo.
    app.all(
      path,
      requireBearerAuth({ verifier: oauth.provider }),
      async (req, res) => {
        await this._dispatchHttp(req, res)
      },
    )

    this._httpServer = httpServer
    this._address = { host: bound.address, port: bound.port, path }
  }

  private async _runHttpSimple(port: number, host: string, path: string): Promise<void> {
    this._resolveDnsRebindingGuards(host)
    const { createServer } = await import('node:http')

    const auth = this._auth

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      // Mcp-Session-Id: legacy (2025-era) session routing, still served alongside
      // modern traffic. MCP-Protocol-Version/Mcp-Method/Mcp-Name: required standard
      // headers for 2026-07-28 requests (SEP-2243). Mcp-Param-* (tool-argument
      // mirroring) is deliberately not listed: browser clients skip that mirroring
      // entirely (dynamically named headers cannot be statically allow-listed for
      // credentialed CORS), so no browser ever needs to send it.
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
    }

    const httpServer = createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders).end()
        return
      }

      if (req.url?.split('?')[0] !== path) {
        res.writeHead(404).end()
        return
      }

      // Attach CORS headers to all responses
      for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v)

      // Auth middleware
      if (auth) {
        const authHeader = req.headers.authorization
        const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

        if (!bearer) {
          res
            .writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="mcp"' })
            .end(JSON.stringify({ error: 'Missing bearer token' }))
          return
        }

        try {
          const accessToken = await auth.verify(bearer)
          ;(req as IncomingMessage & { auth: AuthInfo }).auth = {
            token: accessToken.token,
            clientId: accessToken.clientId ?? '',
            scopes: accessToken.scopes,
            expiresAt: accessToken.expiresAt,
            extra: accessToken.claims,
          }
        } catch (err) {
          if (err instanceof AuthorizationError) {
            res
              .writeHead(403, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ error: err.message }))
          } else {
            res
              .writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="mcp"' })
              .end(JSON.stringify({ error: err instanceof Error ? err.message : 'Authentication failed' }))
          }
          return
        }
      }

      await this._dispatchHttp(req, res)
    })

    this._httpServer = httpServer

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, host, resolve)
    })

    const bound = httpServer.address() as AddressInfo
    this._address = { host: bound.address, port: bound.port, path }
  }

  async close(): Promise<void> {
    await Promise.all(this._proxyCloseCallbacks.map((cb) => cb().catch(() => {})))
    this._proxyCloseCallbacks.length = 0

    await Promise.all(
      [...this._sessions.values()].map(({ transport }) => transport.close().catch(() => {})),
    )
    this._sessions.clear()

    if (this._modernHandler) {
      await this._modernHandler.close()
      this._modernHandler = null
    }

    if (this._stdioHandle) {
      await this._stdioHandle.close()
      this._stdioHandle = null
      this._stdioServer = null
      this._stdioState = null
    }

    if (this._httpServer) {
      await new Promise<void>((resolve, reject) => {
        this._httpServer!.close((err) => (err != null ? reject(err) : resolve()))
      })
      this._httpServer = null
    }
    this._address = null
    await this._primaryServer.close()
  }
}
