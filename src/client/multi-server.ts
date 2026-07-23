import type { LoggingLevel, RequestOptions as SdkRequestOptions } from "@modelcontextprotocol/server";
import { Client as SdkClient, LOG_LEVEL_META_KEY } from '@modelcontextprotocol/client'
import type { McpSubscription, VersionNegotiationOptions, ProtocolEra } from '@modelcontextprotocol/client'
import type { BearerAuth, OAuth, ClientCredentials } from './auth.js'
import type { ClientHandlers, LogHandler, ProgressHandler, ResourceUpdateHandler } from './handlers.js'
import { defaultLogHandler, defaultProgressHandler } from './handlers.js'
import type { CallToolOptions, IClient, RequestOptions } from './interfaces.js'
import type {
  CallToolResult,
  CompletionResult,
  ContentBlock,
  GetPromptResult,
  Prompt,
  Resource,
  TextResourceContents,
  BlobResourceContents,
  ResourceTemplate,
  Tool,
} from './results.js'
import type { McpConfig, McpServerValue } from './transports.js'
import { resolveEntryTransport } from './transports.js'
import type { ClientDefaultOptions } from './client.js'
import { ToolCallError } from './client.js'
// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MultiServerOptions {
  handlers?: ClientHandlers
  /** file:// URIs to advertise to all servers as accessible roots. */
  roots?: string[]
  defaultOptions?: ClientDefaultOptions
  /**
   * Opt-in protocol version negotiation, applied identically to every server
   * in the config (protocol revision 2026-07-28 and later). See
   * `ClientOptions.versionNegotiation` on the single-server `Client` — same
   * semantics, just applied per sub-client here since each connected server
   * negotiates its own era independently. Default `'legacy'`.
   */
  versionNegotiation?: VersionNegotiationOptions
}

// ---------------------------------------------------------------------------
// MultiServerClient
// ---------------------------------------------------------------------------

export class MultiServerClient implements IClient {
  private _clients: Map<string, SdkClient> = new Map()
  private _connectPromise: Promise<void> | null = null
  private _connected = false

  /** URI (or namespaced template URI) → server name, populated by list calls */
  private _uriMap: Map<string, string> = new Map()

  private readonly _config: McpConfig
  private readonly _handlers: {
    log: LogHandler
    progress: ProgressHandler
    sampling?: ClientHandlers['sampling']
    elicitation?: ClientHandlers['elicitation']
  }
  private readonly _roots: string[] | undefined
  private readonly _defaultOptions: ClientDefaultOptions
  private readonly _versionNegotiation: VersionNegotiationOptions | undefined
  private _resourceSubscriptions: Map<string, ResourceUpdateHandler> = new Map()
  /** Modern-era (2026-07-28) subscriptions/listen streams, one per server that
   * currently has active resource subscriptions — see Client's own field of the
   * same purpose for the full rationale. Keyed by server name since each
   * connected server negotiates its own era independently. */
  private _resourceListenSubscriptions: Map<string, McpSubscription> = new Map()
  /** Per-server log level set by setLogLevel() for servers negotiated to modern
   * era — see Client's own field of the same purpose for the full rationale.
   * Keyed by server name since each connected server negotiates its own era
   * independently and may therefore need (or not need) meta-threading. */
  private _logLevels: Map<string, LoggingLevel> = new Map()

  constructor(config: McpConfig, options?: MultiServerOptions) {
    this._config = config
    this._handlers = {
      log: options?.handlers?.log ?? defaultLogHandler,
      progress: options?.handlers?.progress ?? defaultProgressHandler,
      sampling: options?.handlers?.sampling,
      elicitation: options?.handlers?.elicitation,
    }
    this._versionNegotiation = options?.versionNegotiation
    this._roots = options?.roots
    this._defaultOptions = options?.defaultOptions ?? {}
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this._connected) return
    if (this._connectPromise) {
      await this._connectPromise
      return
    }

    this._connectPromise = this._doConnect().finally(() => {
      this._connectPromise = null
    })

    await this._connectPromise
  }

  private async _doConnect(): Promise<void> {
    const entries = Object.entries(this._config.mcpServers)
    if (entries.length === 0) throw new Error('mcpServers config is empty')

    const connected: Array<[string, SdkClient]> = []

    try {
      await Promise.all(
        entries.map(async ([name, entry]) => {
          const sdk = this._buildSdkClient()
          this._registerHandlers(sdk)
          const { transport, beforeConnect } = await resolveEntryTransport(
            entry as McpServerValue,
            undefined,
            { versionNegotiation: this._versionNegotiation },
          )
          if (beforeConnect) await beforeConnect()
          await sdk.connect(transport)
          connected.push([name, sdk])
        }),
      )
    } catch (err) {
      // Roll back any connections that succeeded before the failure.
      await Promise.allSettled(connected.map(([, sdk]) => sdk.close()))
      throw err
    }

    for (const [name, sdk] of connected) {
      this._clients.set(name, sdk)
    }

    this._connected = true
  }

  async close(): Promise<void> {
    if (!this._connected) return
    this._connected = false
    this._uriMap.clear()
    // Close explicitly (and first) so each closure reason is 'local', not 'remote' —
    // see Client.close()'s equivalent ordering for the full rationale.
    await Promise.allSettled(
      [...this._resourceListenSubscriptions.values()].map((sub) => sub.close()),
    )
    this._resourceListenSubscriptions.clear()
    await Promise.allSettled([...this._clients.values()].map((sdk) => sdk.close()))
    this._clients.clear()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  isConnected(): boolean {
    return this._connected
  }

  static async connect(
    config: McpConfig,
    options?: MultiServerOptions,
  ): Promise<MultiServerClient> {
    const client = new MultiServerClient(config, options)
    await client.connect()
    return client
  }

  // -------------------------------------------------------------------------
  // Core protocol
  // -------------------------------------------------------------------------

  /**
   * The protocol era negotiated with a specific named server: `'modern'` for
   * 2026-07-28, `'legacy'` for 2025-11-25 and earlier, `undefined` if the
   * server name is unknown or not yet connected. See
   * `MultiServerOptions.versionNegotiation` — the same mode is requested of
   * every server, but each negotiates (and may land on) its own era
   * independently, so this is necessarily per-server rather than a single
   * client-wide value.
   */
  getProtocolEra(serverName: string): ProtocolEra | undefined {
    return this._clients.get(serverName)?.getProtocolEra()
  }

  /** See Client.ping's docs — the same era-routing applies here, per server,
   * since each connected server negotiates its own era independently. */
  async ping(options?: RequestOptions): Promise<boolean> {
    this._assertConnected()
    await Promise.all(
      [...this._clients.values()].map((sdk) =>
        sdk.getProtocolEra() === 'modern'
          ? sdk.discover(this._toSdkOptions(options))
          : sdk.ping(this._toSdkOptions(options)),
      ),
    )
    return true
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  async listTools(options?: RequestOptions): Promise<Tool[]> {
    this._assertConnected()
    const results = await Promise.all(
      [...this._clients.entries()].map(async ([name, sdk]) => {
        const r = await sdk.listTools(
          this._metaParamsFor(name),
          this._toSdkOptions(options, undefined, this._defaultOptions.tool?.timeout),
        )
        return (r.tools as Tool[]).map((t) => ({ ...t, name: `${name}_${t.name}` }))
      }),
    )
    return results.flat()
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

  async callToolRaw<TData = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<CallToolResult<TData>> {
    const { serverName, localName } = this._parseNamespacedName(name)
    const sdk = this._sdkForServer(serverName)
    const sdkOptions = this._toSdkOptions(
      options,
      options?.onProgress,
      this._defaultOptions.tool?.timeout,
    )
    const result = await sdk.callTool(
      { name: localName, arguments: args ?? {}, ...this._metaParamsFor(serverName) },
      sdkOptions,
    )
    return {
      content: result.content as ContentBlock[],
      structuredContent: (result.structuredContent as TData | undefined) ?? null,
      isError: result.isError === true,
    }
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  async listResources(options?: RequestOptions): Promise<Resource[]> {
    this._assertConnected()
    const results = await Promise.all(
      [...this._clients.entries()].map(async ([name, sdk]) => {
        const r = await sdk.listResources(
          this._metaParamsFor(name),
          this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
        )
        const resources = r.resources as Resource[]
        for (const res of resources) {
          this._uriMap.set(res.uri, name)
        }
        return resources.map((res) => ({
          ...res,
          name: res.name ? `${name}_${res.name}` : res.name,
        }))
      }),
    )
    return results.flat()
  }

  async listResourceTemplates(options?: RequestOptions): Promise<ResourceTemplate[]> {
    this._assertConnected()
    const results = await Promise.all(
      [...this._clients.entries()].map(async ([name, sdk]) => {
        const r = await sdk.listResourceTemplates(
          this._metaParamsFor(name),
          this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
        )
        const templates = r.resourceTemplates as ResourceTemplate[]
        for (const tmpl of templates) {
          this._uriMap.set(tmpl.uriTemplate, name)
        }
        return templates.map((tmpl) => ({
          ...tmpl,
          name: tmpl.name ? `${name}_${tmpl.name}` : tmpl.name,
        }))
      }),
    )
    return results.flat()
  }

  async readResource(
    uri: string,
    options?: RequestOptions,
  ): Promise<Array<TextResourceContents | BlobResourceContents>> {
    this._assertConnected()
    const sdkOptions = this._toSdkOptions(
      options,
      undefined,
      this._defaultOptions.resource?.timeout,
    )

    // Fast path: URI was seen during a previous list call.
    const knownServer = this._uriMap.get(uri)
    if (knownServer) {
      const sdk = this._clients.get(knownServer)!
      const result = await sdk.readResource({ uri, ...this._metaParamsFor(knownServer) }, sdkOptions)
      return result.contents
    }

    // Fallback: try each server in order, return the first success.
    const errors: unknown[] = []
    for (const [name, sdk] of this._clients) {
      try {
        const result = await sdk.readResource({ uri, ...this._metaParamsFor(name) }, sdkOptions)
        return result.contents
      } catch (err) {
        errors.push(err)
      }
    }
    throw new Error(
      `Resource not found on any server: ${uri}\n` +
        errors.map((e) => String(e)).join('\n'),
    )
  }

  // -------------------------------------------------------------------------
  // Prompts
  // -------------------------------------------------------------------------

  async listPrompts(options?: RequestOptions): Promise<Prompt[]> {
    this._assertConnected()
    const results = await Promise.all(
      [...this._clients.entries()].map(async ([name, sdk]) => {
        const r = await sdk.listPrompts(
          this._metaParamsFor(name),
          this._toSdkOptions(options, undefined, this._defaultOptions.prompt?.timeout),
        )
        return (r.prompts as Prompt[]).map((p) => ({ ...p, name: `${name}_${p.name}` }))
      }),
    )
    return results.flat()
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<GetPromptResult> {
    const { serverName, localName } = this._parseNamespacedName(name)
    const sdk = this._sdkForServer(serverName)
    const result = await sdk.getPrompt(
      { name: localName, arguments: args, ...this._metaParamsFor(serverName) },
      this._toSdkOptions(options, undefined, this._defaultOptions.prompt?.timeout),
    )
    return result as GetPromptResult
  }

  // -------------------------------------------------------------------------
  // Resource subscriptions
  // -------------------------------------------------------------------------

  /** See Client.subscribeResource's docs — the same era-routing applies here,
   * per server, since each connected server negotiates its own era. */
  async subscribeResource(
    uri: string,
    handler: ResourceUpdateHandler,
    options?: RequestOptions,
  ): Promise<void> {
    this._assertConnected()
    this._resourceSubscriptions.set(uri, handler)
    const serverName = this._uriMap.get(uri)
    if (serverName) {
      const sdk = this._clients.get(serverName)!
      if (sdk.getProtocolEra() === 'modern') {
        await this._refreshResourceListenSubscriptionForServer(serverName)
      } else {
        await sdk.subscribeResource(
          { uri },
          this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
        )
      }
      return
    }
    // Fallback: the URI's owning server isn't known yet (listResources() was never
    // called). Only legacy-era servers can be probed this way — the validating
    // resources/subscribe RPC either succeeds (that server owns the URI) or throws;
    // listen() has no equivalent per-URI validation, so a modern-era server can't be
    // ruled in or out by trying it, and is skipped in this fallback.
    const errors: unknown[] = []
    for (const [name, sdk] of this._clients) {
      if (sdk.getProtocolEra() === 'modern') continue
      try {
        await sdk.subscribeResource(
          { uri },
          this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
        )
        this._uriMap.set(uri, name)
        return
      } catch (err) {
        errors.push(err)
      }
    }
    throw new Error(`Subscribe failed on all servers:\n${errors.map(String).join('\n')}`)
  }

  async unsubscribeResource(uri: string, options?: RequestOptions): Promise<void> {
    this._assertConnected()
    this._resourceSubscriptions.delete(uri)
    const serverName = this._uriMap.get(uri)
    if (serverName) {
      const sdk = this._clients.get(serverName)!
      if (sdk.getProtocolEra() === 'modern') {
        await this._refreshResourceListenSubscriptionForServer(serverName)
      } else {
        await sdk.unsubscribeResource(
          { uri },
          this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
        )
      }
      return
    }
    await Promise.allSettled(
      [...this._clients.values()]
        .filter((sdk) => sdk.getProtocolEra() !== 'modern')
        .map((sdk) =>
          sdk.unsubscribeResource(
            { uri },
            this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
          ),
        ),
    )
  }

  /** Re-opens server-scoped listen stream for its currently-subscribed URIs — see
   * Client's own private method of the same purpose for the full rationale. */
  private async _refreshResourceListenSubscriptionForServer(serverName: string): Promise<void> {
    const existing = this._resourceListenSubscriptions.get(serverName)
    if (existing) {
      await existing.close()
      this._resourceListenSubscriptions.delete(serverName)
    }
    const uris = [...this._resourceSubscriptions.keys()].filter(
      (uri) => this._uriMap.get(uri) === serverName,
    )
    if (uris.length === 0) return

    const sdk = this._clients.get(serverName)!
    const subscription = await sdk.listen({ resourceSubscriptions: uris })
    this._resourceListenSubscriptions.set(serverName, subscription)

    void subscription.closed.then((reason) => {
      if (reason === 'remote' && this._resourceListenSubscriptions.get(serverName) === subscription) {
        this._resourceListenSubscriptions.delete(serverName)
        void this._refreshResourceListenSubscriptionForServer(serverName).catch(() => {})
      }
    })
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
    this._assertConnected()
    const sdkOptions = this._toSdkOptions(options)

    if (ref.type === 'ref/prompt') {
      const { serverName, localName } = this._parseNamespacedName(ref.name)
      const sdk = this._sdkForServer(serverName)
      const result = await sdk.complete(
        {
          ref: { type: 'ref/prompt', name: localName },
          argument,
          ...(context ? { context } : {}),
          ...this._metaParamsFor(serverName),
        },
        sdkOptions,
      )
      return result.completion as CompletionResult
    }

    const serverName = this._uriMap.get(ref.uri)
    if (serverName) {
      const result = await this._clients.get(serverName)!.complete(
        { ref, argument, ...(context ? { context } : {}), ...this._metaParamsFor(serverName) },
        sdkOptions,
      )
      return result.completion as CompletionResult
    }

    const errors: unknown[] = []
    for (const [name, sdk] of this._clients) {
      try {
        const result = await sdk.complete(
          { ref, argument, ...(context ? { context } : {}), ...this._metaParamsFor(name) },
          sdkOptions,
        )
        return result.completion as CompletionResult
      } catch (err) {
        errors.push(err)
      }
    }
    throw new Error(`Completion failed on all servers:\n${errors.map(String).join('\n')}`)
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  /** See Client.setLogLevel's docs — the same era-routing applies here, per
   * server: legacy sends the real `logging/setLevel` RPC; modern records the
   * level and threads it into `_meta` on that server's subsequent requests via
   * `_metaParamsFor`, since `logging/setLevel` is absent from the modern wire
   * registry (SEP-2577). */
  async setLogLevel(level: LoggingLevel, options?: RequestOptions): Promise<void> {
    this._assertConnected()
    await Promise.all(
      [...this._clients.entries()].map(([name, sdk]) => {
        if (sdk.getProtocolEra() === 'modern') {
          this._logLevels.set(name, level)
          return undefined
        }
        return sdk.setLoggingLevel(level, this._toSdkOptions(options))
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _assertConnected(): void {
    if (!this._connected) {
      throw new Error('MultiServerClient is not connected. Call connect() first.')
    }
  }

  private _parseNamespacedName(name: string): { serverName: string; localName: string } {
    // Sort longest-first so that server names like "my_server" are matched
    // before the shorter prefix "my".
    const serverNames = [...this._clients.keys()].sort((a, b) => b.length - a.length)
    for (const serverName of serverNames) {
      const prefix = `${serverName}_`
      if (name.startsWith(prefix)) {
        return { serverName, localName: name.slice(prefix.length) }
      }
    }
    throw new Error(
      `Tool/prompt name "${name}" has no server namespace prefix. ` +
        `Expected format: "<serverName>_<name>".`,
    )
  }

  private _sdkForServer(serverName: string): SdkClient {
    const sdk = this._clients.get(serverName)
    if (!sdk) {
      throw new Error(
        `No server named "${serverName}" in this MultiServerClient. ` +
          `Known servers: ${[...this._clients.keys()].join(', ')}.`,
      )
    }
    return sdk
  }

  private _buildSdkClient(): SdkClient {
    return new SdkClient(
      { name: 'fastmcp-ts', version: '1.0.0' },
      {
        capabilities: this._buildCapabilities(),
        ...(this._versionNegotiation ? { versionNegotiation: this._versionNegotiation } : {}),
      },
    )
  }

  private _buildCapabilities() {
    return {
      ...(this._handlers.sampling ? { sampling: { tools: {} } } : {}),
      ...(this._handlers.elicitation ? { elicitation: {} } : {}),
      ...(this._roots ? { roots: { listChanged: false } } : {}),
    }
  }

  private _registerHandlers(sdk: SdkClient): void {
    sdk.setNotificationHandler('notifications/message', (notification) => {
      void this._handlers.log({
        level: notification.params.level,
        logger: notification.params.logger ?? undefined,
        data: notification.params.data,
      })
    })

    sdk.setNotificationHandler('notifications/resources/updated', (notification) => {
      const handler = this._resourceSubscriptions.get(notification.params.uri)
      if (handler) void handler(notification.params.uri)
    })

    if (this._handlers.sampling) {
      const h = this._handlers.sampling
      sdk.setRequestHandler('sampling/createMessage', async (req) => h(req.params))
    }

    if (this._handlers.elicitation) {
      const h = this._handlers.elicitation
      sdk.setRequestHandler('elicitation/create', async (req) => h(req.params))
    }

    if (this._roots) {
      const roots = this._roots
      sdk.setRequestHandler('roots/list', async () => ({
        roots: roots.map((uri) => ({ uri })),
      }))
    }
  }

  /** See Client._metaParams's docs — the same purpose, per server name, since
   * each connected server may be on a different era and have a different
   * recorded log level (or none). */
  private _metaParamsFor(serverName: string): { _meta: Record<string, unknown> } | undefined {
    const level = this._logLevels.get(serverName)
    if (level === undefined) return undefined
    return { _meta: { [LOG_LEVEL_META_KEY]: level } }
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
}
