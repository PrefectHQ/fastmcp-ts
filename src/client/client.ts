import { UnauthorizedError, Client as SdkClient } from "@modelcontextprotocol/client";
import type { RequestOptions as SdkRequestOptions, McpSubscription, VersionNegotiationOptions, ProtocolEra } from "@modelcontextprotocol/client";
import { BearerAuth, OAuth } from './auth.js'
import type { ClientCredentials } from './auth.js'
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
  auth?: BearerAuth | OAuth | ClientCredentials | string
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

  private readonly _input: ClientTransportInput
  private readonly _auth: BearerAuth | OAuth | ClientCredentials | undefined
  private readonly _handlers: Required<Omit<ClientHandlers, OptionalHandlerKeys>> &
    Pick<ClientHandlers, OptionalHandlerKeys>
  private readonly _roots: (() => Promise<Root[]>) | undefined
  private readonly _autoInitialize: boolean
  private readonly _versionNegotiation: VersionNegotiationOptions | undefined
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
      },
    )

    this._registerHandlers(sdkClient)

    const { transport, beforeConnect } = await resolveTransport(this._input, this._auth)

    // Bind the server URL into the OAuth provider before the SDK transport
    // reads clientMetadata or tokens() so storage keys are properly namespaced.
    if (this._auth instanceof OAuth) {
      const serverUrl = this._extractServerUrl()
      if (serverUrl) this._auth._bind(serverUrl)
    }

    if (beforeConnect) await beforeConnect()

    try {
      await sdkClient.connect(transport)
    } catch (err) {
      if (err instanceof UnauthorizedError && this._auth instanceof OAuth) {
        // The SDK opened the browser and is waiting for the user to authorize.
        // Wait for the callback to receive the code, then finish auth on the
        // original transport (it holds the discovery/PKCE context) to exchange
        // the code for tokens.
        const code = await this._auth.waitForCallback()
        if (
          'finishAuth' in transport &&
          typeof (transport as Record<string, unknown>).finishAuth === 'function'
        ) {
          await (transport as { finishAuth(code: string): Promise<void> }).finishAuth(
            code,
          )
        }
        // The original transport is already started and cannot be reconnected;
        // build a fresh one for the authenticated attempt. It reads the tokens
        // finishAuth stored in the auth provider.
        const retry = await resolveTransport(this._input, this._auth)
        if (retry.beforeConnect) await retry.beforeConnect()
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

  async ping(options?: RequestOptions): Promise<boolean> {
    await this._sdk().ping(this._toSdkOptions(options))
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
    const result = await this._sdk().listTools(
      undefined,
      this._toSdkOptions(options, undefined, this._defaultOptions.tool?.timeout),
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
    const result = await this._sdk().callTool(
      { name, arguments: args ?? {} },
      sdkOptions,
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
    const result = await this._sdk().listResources(
      undefined,
      this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
    )
    return result.resources as Resource[]
  }

  async listResourceTemplates(options?: RequestOptions): Promise<ResourceTemplate[]> {
    const result = await this._sdk().listResourceTemplates(
      undefined,
      this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
    )
    return result.resourceTemplates as ResourceTemplate[]
  }

  async readResource(
    uri: string,
    options?: RequestOptions,
  ): Promise<Array<TextResourceContents | BlobResourceContents>> {
    const result = await this._sdk().readResource(
      { uri },
      this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
    )
    return result.contents
  }

  /** Returns the raw SDK ReadResourceResult without unwrapping. */
  async readResourceRaw(uri: string, options?: RequestOptions) {
    return this._sdk().readResource(
      { uri },
      this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
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
      await this._sdk().subscribeResource(
        { uri },
        this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
      )
    }
  }

  async unsubscribeResource(uri: string, options?: RequestOptions): Promise<void> {
    this._resourceSubscriptions.delete(uri)
    if (this._sdk().getProtocolEra() === 'modern') {
      await this._refreshResourceListenSubscription()
    } else {
      await this._sdk().unsubscribeResource(
        { uri },
        this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
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

    const subscription = await this._sdk().listen({ resourceSubscriptions: uris })
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
    const result = await this._sdk().listPrompts(
      undefined,
      this._toSdkOptions(options, undefined, this._defaultOptions.prompt?.timeout),
    )
    return result.prompts as Prompt[]
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<GetPromptResult> {
    const result = await this._sdk().getPrompt(
      { name, arguments: args },
      this._toSdkOptions(options, undefined, this._defaultOptions.prompt?.timeout),
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
    const result = await this._sdk().complete(
      { ref, argument, ...(context ? { context } : {}) },
      this._toSdkOptions(options),
    )
    return result.completion as CompletionResult
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  async setLogLevel(level: LoggingLevel, options?: RequestOptions): Promise<void> {
    await this._sdk().setLoggingLevel(level, this._toSdkOptions(options))
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
  auth: BearerAuth | OAuth | ClientCredentials | string | undefined,
): BearerAuth | OAuth | ClientCredentials | undefined {
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
