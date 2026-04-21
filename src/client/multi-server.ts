import { Client as SdkClient } from '@modelcontextprotocol/sdk/client'
import {
  CompatibilityCallToolResultSchema,
  LoggingMessageNotificationSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types'

import type { BearerAuth, OAuth, ClientCredentials } from './auth.js'
import type { ClientHandlers, ProgressHandler } from './handlers.js'
import { defaultLogHandler, defaultProgressHandler } from './handlers.js'
import type { CallToolOptions, IClient, RequestOptions } from './interfaces.js'
import type {
  CallToolResult,
  ContentBlock,
  GetPromptResult,
  Prompt,
  Resource,
  ResourceContents,
  ResourceTemplate,
  Tool,
} from './results.js'
import type { McpConfig, McpServerValue } from './transports.js'
import { resolveEntryTransport } from './transports.js'
import type { ClientDefaultOptions } from './client.js'
import { ToolCallError } from './client.js'
import type { RequestOptions as SdkRequestOptions } from '@modelcontextprotocol/sdk/shared/protocol'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MultiServerOptions {
  handlers?: ClientHandlers
  /** file:// URIs to advertise to all servers as accessible roots. */
  roots?: string[]
  defaultOptions?: ClientDefaultOptions
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
  private readonly _handlers: Required<Omit<ClientHandlers, 'sampling' | 'elicitation'>> &
    Pick<ClientHandlers, 'sampling' | 'elicitation'>
  private readonly _roots: string[] | undefined
  private readonly _defaultOptions: ClientDefaultOptions

  constructor(config: McpConfig, options?: MultiServerOptions) {
    this._config = config
    this._handlers = {
      log: options?.handlers?.log ?? defaultLogHandler,
      progress: options?.handlers?.progress ?? defaultProgressHandler,
      sampling: options?.handlers?.sampling,
      elicitation: options?.handlers?.elicitation,
    }
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
          const { transport, beforeConnect } = resolveEntryTransport(
            entry as McpServerValue,
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

  async ping(options?: RequestOptions): Promise<boolean> {
    this._assertConnected()
    await Promise.all(
      [...this._clients.values()].map((sdk) =>
        sdk.ping(this._toSdkOptions(options)),
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
          undefined,
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
      { name: localName, arguments: args ?? {} },
      CompatibilityCallToolResultSchema,
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
          undefined,
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
          undefined,
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

  async readResource(uri: string, options?: RequestOptions): Promise<ResourceContents[]> {
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
      const result = await sdk.readResource({ uri }, sdkOptions)
      return result.contents as ResourceContents[]
    }

    // Fallback: try each server in order, return the first success.
    const errors: unknown[] = []
    for (const sdk of this._clients.values()) {
      try {
        const result = await sdk.readResource({ uri }, sdkOptions)
        return result.contents as ResourceContents[]
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
          undefined,
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
      { name: localName, arguments: args },
      this._toSdkOptions(options, undefined, this._defaultOptions.prompt?.timeout),
    )
    return result as GetPromptResult
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
    const idx = name.indexOf('_')
    if (idx === -1) {
      throw new Error(
        `Tool/prompt name "${name}" has no server namespace prefix. ` +
          `Expected format: "<serverName>_<name>".`,
      )
    }
    return { serverName: name.slice(0, idx), localName: name.slice(idx + 1) }
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
      { capabilities: this._buildCapabilities() },
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
    sdk.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      void this._handlers.log({
        level: notification.params.level,
        logger: notification.params.logger ?? undefined,
        data: notification.params.data,
      })
    })

    if (this._handlers.sampling) {
      const h = this._handlers.sampling
      sdk.setRequestHandler(CreateMessageRequestSchema, async (req) => h(req.params))
    }

    if (this._handlers.elicitation) {
      const h = this._handlers.elicitation
      sdk.setRequestHandler(ElicitRequestSchema, async (req) => h(req.params))
    }

    if (this._roots) {
      const roots = this._roots
      sdk.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: roots.map((uri) => ({ uri })),
      }))
    }
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
