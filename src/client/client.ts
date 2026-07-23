import { UnauthorizedError, Client as SdkClient, LOG_LEVEL_META_KEY } from "@modelcontextprotocol/client";
import type {
  RequestOptions as SdkRequestOptions,
  McpSubscription,
  VersionNegotiationOptions,
  ProtocolEra,
  PriorDiscovery,
  InputRequiredOptions,
  ResponseCacheStore,
  Transport,
} from "@modelcontextprotocol/client";
import { BearerAuth, OAuth } from './auth.js'
import type { AsyncHeaderAuth } from './auth.js'
import type { ClientHandlers, ListChangedHandler, ProgressHandler, ResourceUpdateHandler } from './handlers.js'
import { defaultLogHandler, defaultProgressHandler } from './handlers.js'
import type { CallToolOptions, IClient, RequestOptions } from './interfaces.js'
import type {
  CallToolResult,
  CompletionResult,
  ContentBlock,
  GetPromptResult,
  LoggingLevel,
  Prompt,
  Resource,
  TextResourceContents,
  BlobResourceContents,
  ResourceTemplate,
  Root,
  Tool,
} from './results.js'
import type { ClientTransportInput, McpConfig } from './transports.js'
import { resolveTransport } from './transports.js'
import type { MultiServerOptions } from './multi-server.js'
import { MultiServerClient } from './multi-server.js'

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ToolCallError extends Error {
  readonly content: ContentBlock[]

  constructor(message: string, content: ContentBlock[]) {
    super(message)
    this.name = 'ToolCallError'
    this.content = content
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

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
  handlers?: ClientHandlers
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
   * Opt-in protocol version negotiation (protocol revision 2026-07-28 and later).
   * The default is `'legacy'`: connect() runs the plain 2025 sequence, byte-identical
   * to today's behavior (no probe, no new headers). Pass `{ mode: 'auto' }` to probe
   * with `server/discover` and use the modern era when the server supports it
   * (falling back to legacy otherwise), or `{ mode: { pin: '2026-07-28' } }` to
   * require the modern era outright. See `getProtocolEra()` to read the negotiated
   * result after connecting.
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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type OptionalHandlerKeys =
  | 'sampling'
  | 'elicitation'
  | 'onToolsListChanged'
  | 'onResourcesListChanged'
  | 'onPromptsListChanged'

export class Client implements IClient {
  private _sdkClient: SdkClient | null = null
  private _refCount = 0
  private _connectPromise: Promise<void> | null = null
  private readonly _resourceSubscriptions = new Map<string, ResourceUpdateHandler>()
  /** The modern-era (2026-07-28) `subscriptions/listen` stream backing all active
   * resource subscriptions — resources/subscribe and resources/unsubscribe are
   * 2025-only RPCs, physically absent from the modern method registry. Unused
   * (stays undefined) on a legacy connection. */
  private _resourceListenSubscription: McpSubscription | undefined
  /** The live SDK transport captured at connect(). Its `finishAuth()` redeems the
   * authorization code both during connect-time recovery and a post-connect
   * step-up re-authorization. */
  private _transport: Transport | undefined
  /** Single-flight guard for a post-connect re-authorization round: concurrent
   * interactive-OAuth 401s share one `waitForCallback`→`finishAuth` round rather
   * than each opening its own. Cleared when the round settles. */
  private _reauthPromise: Promise<void> | null = null
  /** Max post-connect re-authorization rounds per request (see `_reauthRetry`):
   * 1 for ordinary step-up, 2 to also cover SEP-2352 authorization-server
   * migration (the AS changes mid-request). Bounded so a genuinely unauthorized
   * request cannot loop forever. */
  private static readonly _MAX_REAUTH_ROUNDS = 2

  private readonly _input: ClientTransportInput
  private readonly _auth: BearerAuth | OAuth | AsyncHeaderAuth | undefined
  private readonly _handlers: Required<Omit<ClientHandlers, OptionalHandlerKeys>> &
    Pick<ClientHandlers, OptionalHandlerKeys>
  private readonly _roots: (() => Promise<Root[]>) | undefined
  private readonly _autoInitialize: boolean
  private readonly _versionNegotiation: VersionNegotiationOptions | undefined
  private readonly _prior: PriorDiscovery | undefined
  private readonly _inputRequired: InputRequiredOptions | undefined
  private readonly _responseCacheStore: ResponseCacheStore | undefined
  private readonly _cachePartition: string | undefined
  private readonly _defaultCacheTtlMs: number | undefined
  private readonly _legacySSE: boolean
  /** Set by setLogLevel() on a modern-era connection (where logging/setLevel is
   * not a wire method) — threaded into `_meta[LOG_LEVEL_META_KEY]` on every
   * subsequent request. Unused on legacy era, where setLogLevel() still sends
   * the real `logging/setLevel` RPC. */
  private _logLevel: LoggingLevel | undefined
  private readonly _defaultOptions: ClientDefaultOptions

  constructor(input: ClientTransportInput, options?: ClientOptions) {
    this._input = input
    this._auth = resolveAuth(options?.auth)
    this._handlers = {
      log: options?.handlers?.log ?? defaultLogHandler,
      progress: options?.handlers?.progress ?? defaultProgressHandler,
      sampling: options?.handlers?.sampling,
      elicitation: options?.handlers?.elicitation,
      onToolsListChanged: options?.handlers?.onToolsListChanged,
      onResourcesListChanged: options?.handlers?.onResourcesListChanged,
      onPromptsListChanged: options?.handlers?.onPromptsListChanged,
    }
    this._roots = options?.roots ? normalizeRootsOption(options.roots) : undefined
    this._autoInitialize = options?.autoInitialize ?? true
    this._versionNegotiation = options?.versionNegotiation
    this._prior = options?.prior
    this._inputRequired = options?.inputRequired
    this._responseCacheStore = options?.responseCacheStore
    this._cachePartition = options?.cachePartition
    this._defaultCacheTtlMs = options?.defaultCacheTtlMs
    this._legacySSE = options?.legacySSE ?? false
    this._defaultOptions = options?.defaultOptions ?? {}
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this._refCount++

    // If another concurrent connect() is in progress, wait for it.
    if (this._connectPromise) {
      await this._connectPromise
      return
    }

    // Already connected — just bump the ref count.
    if (this._sdkClient) return

    this._connectPromise = this._doConnect().finally(() => {
      this._connectPromise = null
    })

    try {
      await this._connectPromise
    } catch (err) {
      this._refCount = Math.max(0, this._refCount - 1)
      throw err
    }
  }

  private async _doConnect(): Promise<void> {
    const sdkClient = new SdkClient(
      { name: 'fastmcp-ts', version: '1.0.0' },
      {
        capabilities: this._buildCapabilities(),
        listChanged: this._buildListChangedConfig(),
        ...(this._versionNegotiation ? { versionNegotiation: this._versionNegotiation } : {}),
        ...(this._inputRequired ? { inputRequired: this._inputRequired } : {}),
        ...(this._responseCacheStore ? { responseCacheStore: this._responseCacheStore } : {}),
        ...(this._cachePartition !== undefined ? { cachePartition: this._cachePartition } : {}),
        ...(this._defaultCacheTtlMs !== undefined
          ? { defaultCacheTtlMs: this._defaultCacheTtlMs }
          : {}),
      },
    )

    this._registerHandlers(sdkClient)

    const { transport, beforeConnect } = await resolveTransport(this._input, this._auth, {
      legacySSE: this._legacySSE,
      versionNegotiation: this._versionNegotiation,
    })

    // Bind the server URL into the OAuth provider before the SDK transport
    // reads clientMetadata or tokens() so storage keys are properly namespaced.
    if (this._auth instanceof OAuth) {
      const serverUrl = this._extractServerUrl()
      if (serverUrl) this._auth._bind(serverUrl)
    }

    if (beforeConnect) await beforeConnect()

    this._transport = transport
    try {
      await sdkClient.connect(transport, this._prior ? { prior: this._prior } : undefined)
    } catch (err) {
      if (err instanceof UnauthorizedError && this._auth instanceof OAuth) {
        // The SDK opened the browser and is waiting for the user to authorize.
        // Wait for the callback to receive the full callback params (code +,
        // when present, the RFC 9207 `iss` parameter), then finish auth on the
        // original transport (it holds the discovery/PKCE context) to exchange
        // the code for tokens. Passing URLSearchParams (rather than a bare
        // code string) lets the SDK validate `iss` against the recorded
        // issuer before redeeming the code.
        const callbackParams = await this._auth.waitForCallback()
        await this._finishAuth(transport, callbackParams)
        // The original transport is already started and cannot be reconnected;
        // build a fresh one for the authenticated attempt. It reads the tokens
        // finishAuth stored in the auth provider.
        const retry = await resolveTransport(this._input, this._auth)
        if (retry.beforeConnect) await retry.beforeConnect()
        this._transport = retry.transport
        await sdkClient.connect(retry.transport)
      } else {
        throw err
      }
    }

    this._sdkClient = sdkClient
  }

  private _extractServerUrl(): string | undefined {
    const input = this._input
    if (typeof input === 'string') return input
    if (
      typeof input === 'object' &&
      input !== null &&
      'mcpServers' in input
    ) {
      const entries = Object.entries(
        (input as { mcpServers: Record<string, { url?: string }> }).mcpServers,
      )
      if (entries.length > 0) {
        const [, entry] = entries[0]!
        if (entry && 'url' in entry && typeof entry.url === 'string') {
          return entry.url
        }
      }
    }
    return undefined
  }

  async close(): Promise<void> {
    this._refCount = Math.max(0, this._refCount - 1)
    if (this._refCount > 0) return

    // Close explicitly (and first) so its closure reason is 'local', not 'remote' —
    // otherwise the resource-subscription robustness handler above would try to
    // re-listen through a client that is already torn down.
    if (this._resourceListenSubscription) {
      await this._resourceListenSubscription.close().catch(() => {})
      this._resourceListenSubscription = undefined
    }

    const sdk = this._sdkClient
    this._sdkClient = null
    if (sdk) await sdk.close()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  isConnected(): boolean {
    return this._sdkClient !== null
  }

  /** Creates a connected MultiServerClient when given a multi-entry McpConfig. */
  static async connect(input: McpConfig, options?: MultiServerOptions): Promise<MultiServerClient>
  /** Creates a connected Client for a single-server transport. Use with `await using` for automatic cleanup. */
  static async connect(input: ClientTransportInput, options?: ClientOptions): Promise<Client>
  static async connect(
    input: ClientTransportInput | McpConfig,
    options?: ClientOptions | MultiServerOptions,
  ): Promise<Client | MultiServerClient> {
    if (
      typeof input === 'object' &&
      input !== null &&
      'mcpServers' in input &&
      Object.keys((input as McpConfig).mcpServers).length > 1
    ) {
      return MultiServerClient.connect(input as McpConfig, options as MultiServerOptions)
    }
    const client = new Client(input as ClientTransportInput, options as ClientOptions)
    await client.connect()
    return client
  }

  // -------------------------------------------------------------------------
  // Core protocol
  // -------------------------------------------------------------------------

  /**
   * Liveness check. On a legacy-era connection this sends the `ping` RPC. On a
   * modern (2026-07-28) connection `ping` is not a wire method — the era's
   * registry deliberately excludes it — so this sends `server/discover`
   * instead: any successful response is equally strong liveness evidence, and
   * `discover()` is the SDK-native modern equivalent (rather than a
   * hand-rolled substitute). Returns `false` only on legacy `ping`'s own
   * result; a modern-era failure throws, matching `ping()`'s existing
   * throw-on-failure contract.
   */
  async ping(options?: RequestOptions): Promise<boolean> {
    if (this.getProtocolEra() === 'modern') {
      await this._reauthRetry(() => this._sdk().discover(this._toSdkOptions(options)))
      return true
    }
    await this._reauthRetry(() => this._sdk().ping(this._toSdkOptions(options)))
    return true
  }

  /**
   * The protocol era negotiated at connect(): `'modern'` for 2026-07-28 (per-request
   * envelope), `'legacy'` for 2025-11-25 and earlier (the `initialize` handshake).
   * `undefined` before connect(). See `ClientOptions.versionNegotiation`.
   */
  getProtocolEra(): ProtocolEra | undefined {
    return this._sdkClient?.getProtocolEra()
  }

  // -------------------------------------------------------------------------
  // Tools (IToolsClient)
  // -------------------------------------------------------------------------

  async listTools(options?: RequestOptions): Promise<Tool[]> {
    const result = await this._reauthRetry(() =>
      this._sdk().listTools(
        this._metaParams(),
        this._toSdkOptions(options, undefined, this._defaultOptions.tool?.timeout),
      ),
    )
    return result.tools as Tool[]
  }

  async callTool<TData = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<CallToolResult<TData>> {
    const raw = await this.callToolRaw<TData>(name, args, options)
    if (raw.isError) {
      const message =
        (raw.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n') || 'Tool returned an error'
      throw new ToolCallError(message, raw.content)
    }
    return raw
  }

  /** Returns the full result including isError without throwing. */
  async callToolRaw<TData = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<CallToolResult<TData>> {
    const sdkOptions = this._toSdkOptions(
      options,
      options?.onProgress,
      this._defaultOptions.tool?.timeout,
    )
    const result = await this._reauthRetry(() =>
      this._sdk().callTool({ name, arguments: args ?? {}, ...this._metaParams() }, sdkOptions),
    )
    return {
      content: result.content as ContentBlock[],
      structuredContent: (result.structuredContent as TData | undefined) ?? null,
      isError: result.isError === true,
    }
  }

  // -------------------------------------------------------------------------
  // Resources (IResourcesClient)
  // -------------------------------------------------------------------------

  async listResources(options?: RequestOptions): Promise<Resource[]> {
    const result = await this._reauthRetry(() =>
      this._sdk().listResources(
        this._metaParams(),
        this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
      ),
    )
    return result.resources as Resource[]
  }

  async listResourceTemplates(options?: RequestOptions): Promise<ResourceTemplate[]> {
    const result = await this._reauthRetry(() =>
      this._sdk().listResourceTemplates(
        this._metaParams(),
        this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
      ),
    )
    return result.resourceTemplates as ResourceTemplate[]
  }

  async readResource(
    uri: string,
    options?: RequestOptions,
  ): Promise<Array<TextResourceContents | BlobResourceContents>> {
    const result = await this._reauthRetry(() =>
      this._sdk().readResource(
        { uri, ...this._metaParams() },
        this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
      ),
    )
    return result.contents
  }

  /** Returns the raw SDK ReadResourceResult without unwrapping. */
  async readResourceRaw(uri: string, options?: RequestOptions) {
    return this._reauthRetry(() =>
      this._sdk().readResource(
        { uri, ...this._metaParams() },
        this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
      ),
    )
  }

  /**
   * Subscribes to change notifications for a resource URI. `handler` fires whenever
   * the server sends a matching update, on either protocol era: on a legacy
   * (2025-era) connection via the `resources/subscribe` RPC and unsolicited
   * `notifications/resources/updated` push, or on a modern (2026-07-28) connection
   * via a `subscriptions/listen` stream opted into `resourceSubscriptions` — both
   * dispatch to the same `notifications/resources/updated` handler registered in
   * `_registerHandlers`, so this method is the only era-aware part.
   */
  async subscribeResource(
    uri: string,
    handler: ResourceUpdateHandler,
    options?: RequestOptions,
  ): Promise<void> {
    this._resourceSubscriptions.set(uri, handler)
    if (this._sdk().getProtocolEra() === 'modern') {
      await this._refreshResourceListenSubscription()
    } else {
      await this._reauthRetry(() =>
        this._sdk().subscribeResource(
          { uri, ...this._metaParams() },
          this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
        ),
      )
    }
  }

  async unsubscribeResource(uri: string, options?: RequestOptions): Promise<void> {
    this._resourceSubscriptions.delete(uri)
    if (this._sdk().getProtocolEra() === 'modern') {
      await this._refreshResourceListenSubscription()
    } else {
      await this._reauthRetry(() =>
        this._sdk().unsubscribeResource(
          { uri, ...this._metaParams() },
          this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
        ),
      )
    }
  }

  /**
   * Re-opens the modern-era resource-subscription listen stream with the current
   * set of subscribed URIs. `listen()` has no in-place filter update, so every
   * subscribe/unsubscribe on a modern connection closes the existing stream (if
   * any) and opens a fresh one — `subscribeResource`/`unsubscribeResource` are not
   * expected to be called at a high frequency, so this is not a hot path.
   */
  private async _refreshResourceListenSubscription(): Promise<void> {
    if (this._resourceListenSubscription) {
      await this._resourceListenSubscription.close()
      this._resourceListenSubscription = undefined
    }
    const uris = [...this._resourceSubscriptions.keys()]
    if (uris.length === 0) return

    // The modern subscribeResource/unsubscribeResource leg: opening the
    // `subscriptions/listen` stream is a server-auth-gated request, so it steps
    // up on a post-connect 401 like every other request method.
    const subscription = await this._reauthRetry(() =>
      this._sdk().listen({ resourceSubscriptions: uris }),
    )
    this._resourceListenSubscription = subscription

    // Robustness: an unexpected disconnect ('remote') re-establishes the stream so
    // resource-update delivery survives a dropped connection. A deliberate
    // server-side close ('graceful') is respected — the server chose to end it, and
    // re-listening would fight that decision. A close we triggered ourselves
    // ('local' — e.g. this same method superseding it above) needs no action; the
    // subscription-identity check also protects against acting on a stale handle.
    void subscription.closed.then((reason) => {
      if (reason === 'remote' && this._resourceListenSubscription === subscription) {
        this._resourceListenSubscription = undefined
        void this._refreshResourceListenSubscription().catch(() => {})
      }
    })
  }

  // -------------------------------------------------------------------------
  // Prompts (IPromptsClient)
  // -------------------------------------------------------------------------

  async listPrompts(options?: RequestOptions): Promise<Prompt[]> {
    const result = await this._reauthRetry(() =>
      this._sdk().listPrompts(
        this._metaParams(),
        this._toSdkOptions(options, undefined, this._defaultOptions.prompt?.timeout),
      ),
    )
    return result.prompts as Prompt[]
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<GetPromptResult> {
    const result = await this._reauthRetry(() =>
      this._sdk().getPrompt(
        { name, arguments: args, ...this._metaParams() },
        this._toSdkOptions(options, undefined, this._defaultOptions.prompt?.timeout),
      ),
    )
    return result as GetPromptResult
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  async complete(
    ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string },
    argument: { name: string; value: string },
    context?: { arguments?: Record<string, string> },
    options?: RequestOptions,
  ): Promise<CompletionResult> {
    const result = await this._reauthRetry(() =>
      this._sdk().complete(
        { ref, argument, ...(context ? { context } : {}), ...this._metaParams() },
        this._toSdkOptions(options),
      ),
    )
    return result.completion as CompletionResult
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  /**
   * Sets the minimum severity level for log messages sent by the server. On a
   * legacy-era connection this sends the `logging/setLevel` RPC, unchanged. On
   * a modern (2026-07-28) connection `logging/setLevel` is deprecated (SEP-2577)
   * and physically absent from the era's registry — there is no RPC to send.
   * Instead, the level is recorded and threaded into
   * `_meta['io.modelcontextprotocol/logLevel']` on every subsequent request via
   * `_metaParams()`, per request; user-supplied `_meta` still wins if a caller
   * passes one explicitly (there is no such call site in this class today).
   */
  async setLogLevel(level: LoggingLevel, options?: RequestOptions): Promise<void> {
    if (this.getProtocolEra() === 'modern') {
      this._logLevel = level
      return
    }
    await this._reauthRetry(() =>
      this._sdk().setLoggingLevel(level, this._toSdkOptions(options)),
    )
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _sdk(): SdkClient {
    if (!this._sdkClient) {
      throw new Error('Client is not connected. Call connect() first.')
    }
    return this._sdkClient
  }

  /**
   * Runs a post-connect SDK request and, when it rejects with the SDK's
   * `UnauthorizedError` under an interactive {@link OAuth} provider, performs a
   * bounded number of step-up re-authorization rounds — the same
   * `waitForCallback`→`finishAuth` machinery `connect()` uses — retrying the
   * request after each.
   *
   * This closes the post-connect gap for interactive OAuth: a request that 401s
   * (missing/expired token) or 403s with an `insufficient_scope` challenge (a
   * broader scope is required for that operation) drives the SDK transport to
   * issue a fresh, scope-honoring authorization request and re-throw
   * `UnauthorizedError` — the transport picks the challenged/union scope itself
   * (`extractWWWAuthenticateParams` + `computeScopeUnion`); this wrapper only
   * completes the interrupted round and retries.
   *
   * The bound is {@link Client._MAX_REAUTH_ROUNDS}. One round covers ordinary
   * step-up (a single 401/403). Two rounds cover SEP-2352 authorization-server
   * migration: the first authenticated request flips the MCP server to a new
   * authorization server (its Protected Resource Metadata now lists a different
   * issuer), so the very next request 401s and must re-discover, re-register, and
   * re-authorize at the NEW server — a second round on the same wrapped request.
   * Beyond the bound the `UnauthorizedError` propagates, so a genuinely
   * unauthorized request never loops forever.
   *
   * Each round is single-flight: concurrent 401s share one `_reauthPromise`, and
   * each caller retries its own request after it resolves — a burst never opens
   * multiple browsers.
   *
   * Non-interactive auth is never re-authorized here — the original error
   * propagates unchanged. `BearerAuth` and custom headers carry no interactive
   * step, and a {@link ClientCredentials} scope failure is a machine-to-machine
   * misconfiguration (no user, no browser), not a step-up flow.
   * `MultiServerClient` configures no interactive OAuth by design, so this path
   * stays inert there.
   *
   * Every outbound request method routes through this wrapper, with one
   * exception: {@link Client.notifyRootsChanged} calls the SDK directly. It sends
   * a notification, not a request, so there is no response to 401/403 and
   * nothing to retry.
   *
   * `BrowserOAuth` (`extends OAuth`) is covered by the same guard, and its
   * `waitForCallback` is sound for a post-connect round — `redirectToAuthorization`
   * arms the callback promise before the transport re-throws. Two browser-only
   * caveats apply, honestly: in **popup** mode `window.open` needs a user gesture,
   * so a step-up fired from a request not within one is blocked and the re-auth
   * error propagates (call from a click); **redirect** mode navigates the whole
   * tab away (`window.location.assign`), destroying this in-flight retry — the app
   * recovers via `resumeFromRedirect()` on the return load and a fresh request,
   * not by this wrapper. The migration second round inherits the popup caveat: it
   * runs outside the original user gesture, so under `BrowserOAuth` popup mode it
   * hits the user-gesture block and surfaces as that error rather than opening a
   * second popup.
   */
  private async _reauthRetry<T>(op: () => Promise<T>): Promise<T> {
    let rounds = 0
    for (;;) {
      try {
        return await op()
      } catch (err) {
        if (!(err instanceof UnauthorizedError) || !(this._auth instanceof OAuth)) throw err
        // Bounded — see _MAX_REAUTH_ROUNDS. Beyond the bound the error propagates
        // so a genuinely unauthorized request never loops forever.
        if (rounds >= Client._MAX_REAUTH_ROUNDS) throw err
        rounds++
        await this._reauthorize(this._auth)
      }
    }
  }

  /** Single-flight wrapper around one re-authorization round. */
  private async _reauthorize(auth: OAuth): Promise<void> {
    this._reauthPromise ??= this._doReauthorize(auth).finally(() => {
      this._reauthPromise = null
    })
    await this._reauthPromise
  }

  /**
   * One re-authorization round: await the authorization callback the SDK
   * transport already armed (its 401/403 handling ran discovery + opened the
   * browser with the challenged scope), then `finishAuth()` redeems the code for
   * the broader-scope token on the live transport. The very next request reads
   * that token via the transport's per-request bearer-token bridge.
   *
   * After redeeming, the cached discovery state is invalidated so that the NEXT
   * authorization leg re-discovers the Protected Resource Metadata from scratch.
   * The SDK's `auth()` otherwise pins to the authorization server it first cached
   * and re-fetches PRM only when it has none — so it never notices a SEP-2352
   * migration (PRM `authorization_servers` changing to a new issuer). Clearing it
   * here (after the current round's callback leg has already consumed it) makes a
   * subsequent 401 re-run discovery, land on the new server, and register there.
   * Re-discovery is idempotent when the server has NOT migrated, so ordinary
   * step-up and token-refresh rounds are unaffected beyond one extra metadata
   * fetch.
   */
  private async _doReauthorize(auth: OAuth): Promise<void> {
    const callbackParams = await auth.waitForCallback()
    // `_transport` is always set post-connect (assigned in _doConnect before
    // `_sdkClient`), and this round only ever runs after a successful request —
    // so the guard is theoretical. It stays only to keep the type non-null
    // without a non-null assertion; a missing transport silently no-ops rather
    // than throwing, which is the safer degradation if that invariant ever breaks.
    if (this._transport) await this._finishAuth(this._transport, callbackParams)
    await auth.invalidateCredentials('discovery')
  }

  /**
   * Redeems the authorization callback params for tokens on `transport`, if it
   * exposes `finishAuth` (StreamableHTTP and SSE do). Shared by connect-time
   * recovery and post-connect step-up. Passing `URLSearchParams` (not a bare
   * code) lets the SDK validate the RFC 9207 `iss` before redeeming.
   */
  private async _finishAuth(transport: Transport, params: URLSearchParams): Promise<void> {
    if (
      'finishAuth' in transport &&
      typeof (transport as Record<string, unknown>).finishAuth === 'function'
    ) {
      await (transport as { finishAuth(p: URLSearchParams): Promise<void> }).finishAuth(params)
    }
  }

  /**
   * The `_meta` override to merge into an outbound request's params — carries
   * `_logLevel` (set by setLogLevel() on a modern-era connection) so it rides
   * along on every subsequent request. Returns `undefined` (not `{}`) when
   * there is nothing to attach, so `{...this._metaParams()}` is a no-op and
   * callers that pass no params at all can keep passing `undefined` unchanged.
   */
  private _metaParams(): { _meta: Record<string, unknown> } | undefined {
    if (this._logLevel !== undefined && this.getProtocolEra() === 'modern') {
      return { _meta: { [LOG_LEVEL_META_KEY]: this._logLevel } }
    }
    return undefined
  }

  private _toSdkOptions(
    options?: RequestOptions,
    overrideProgress?: ProgressHandler,
    scopedTimeoutSeconds?: number,
  ): SdkRequestOptions {
    const timeoutSeconds =
      options?.timeout ?? scopedTimeoutSeconds ?? this._defaultOptions.timeout
    const progressHandler = overrideProgress ?? this._handlers.progress

    const sdkOptions: SdkRequestOptions = {}
    if (timeoutSeconds != null) sdkOptions.timeout = timeoutSeconds * 1000
    if (options?.signal) sdkOptions.signal = options.signal
    if (progressHandler) {
      sdkOptions.onprogress = ({ progress, total, message }) => {
        void progressHandler(progress, total, message)
      }
    }
    return sdkOptions
  }

  private _buildCapabilities() {
    return {
      ...(this._handlers.sampling ? { sampling: { tools: {} } } : {}),
      ...(this._handlers.elicitation ? { elicitation: {} } : {}),
      ...(this._roots ? { roots: { listChanged: true } } : {}),
    }
  }

  private _buildListChangedConfig() {
    const { onToolsListChanged, onResourcesListChanged, onPromptsListChanged } = this._handlers
    if (!onToolsListChanged && !onResourcesListChanged && !onPromptsListChanged) return undefined

    const adapt = <T>(h: ListChangedHandler<T>) => ({
      onChanged: (err: Error | null, items: T[] | null) => { void h.onChanged(err, items) },
      ...(h.autoRefresh !== undefined ? { autoRefresh: h.autoRefresh } : {}),
      ...(h.debounceMs !== undefined ? { debounceMs: h.debounceMs } : {}),
    })

    return {
      ...(onToolsListChanged ? { tools: adapt(onToolsListChanged) } : {}),
      ...(onResourcesListChanged ? { resources: adapt(onResourcesListChanged) } : {}),
      ...(onPromptsListChanged ? { prompts: adapt(onPromptsListChanged) } : {}),
    }
  }

  private _registerHandlers(sdk: SdkClient): void {
    // Log notifications from the server
    sdk.setNotificationHandler('notifications/message', (notification) => {
      void this._handlers.log({
        level: notification.params.level,
        logger: notification.params.logger ?? undefined,
        data: notification.params.data,
      })
    })

    // Resource update notifications (for active subscriptions)
    sdk.setNotificationHandler('notifications/resources/updated', (notification) => {
      const handler = this._resourceSubscriptions.get(notification.params.uri)
      if (handler) void handler(notification.params.uri)
    })

    // Sampling: server requests an LLM completion from the client
    if (this._handlers.sampling) {
      const samplingHandler = this._handlers.sampling
      sdk.setRequestHandler('sampling/createMessage', async (request) => {
        return samplingHandler(request.params)
      })
    }

    // Elicitation: server requests structured user input
    if (this._handlers.elicitation) {
      const elicitationHandler = this._handlers.elicitation
      sdk.setRequestHandler('elicitation/create', async (request) => {
        return elicitationHandler(request.params)
      })
    }

    // Roots: server requests the client's accessible filesystem roots
    if (this._roots) {
      const getRoots = this._roots
      sdk.setRequestHandler('roots/list', async () => ({
        roots: await getRoots(),
      }))
    }
  }

  // -------------------------------------------------------------------------
  // Roots
  // -------------------------------------------------------------------------

  /**
   * Notify the connected server that the client's roots list has changed.
   * The server should re-issue a roots/list request to get the updated list.
   */
  async notifyRootsChanged(): Promise<void> {
    await this._sdk().sendRootsListChanged()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAuth(
  auth: BearerAuth | OAuth | AsyncHeaderAuth | string | undefined,
): BearerAuth | OAuth | AsyncHeaderAuth | undefined {
  if (!auth) return undefined
  if (typeof auth === 'string') return new BearerAuth(auth)
  return auth
}

function normalizeRootsOption(roots: RootsValue): () => Promise<Root[]> {
  if (typeof roots === 'function') {
    return async () => Promise.all((await roots()).map(normalizeRootInput))
  }
  return async () => Promise.all(roots.map(normalizeRootInput))
}

async function normalizeRootInput(input: RootInput): Promise<Root> {
  if (typeof input === 'string') return { uri: await normalizeRootUri(input) }
  return { ...input, uri: await normalizeRootUri(input.uri) }
}

async function normalizeRootUri(input: string): Promise<string> {
  // Already a URI (file://, http://, ...) — pass through with no Node import.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input
  // A bare filesystem path requires Node to resolve against the cwd.
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error(
      `Cannot normalize filesystem root "${input}" in a browser. Pass a file:// URI instead.`,
    )
  }
  const { resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  return pathToFileURL(resolve(input)).href
}
