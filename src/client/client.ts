import { Client as SdkClient } from '@modelcontextprotocol/sdk/client'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  CompatibilityCallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types'
import type { RequestOptions as SdkRequestOptions } from '@modelcontextprotocol/sdk/shared/protocol'

import { BearerAuth, OAuth } from './auth.js'
import type { ClientCredentials } from './auth.js'
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
import type { ClientTransportInput } from './transports.js'
import { resolveTransport } from './transports.js'

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

export interface ClientOptions {
  /**
   * Authentication to attach to HTTP requests.
   * A plain string is treated as a Bearer token.
   */
  auth?: BearerAuth | OAuth | ClientCredentials | string
  handlers?: ClientHandlers
  /** file:// URIs to advertise to the server as accessible roots. */
  roots?: string[]
  /**
   * When true (default), the MCP initialize handshake is performed
   * automatically inside connect().
   */
  autoInitialize?: boolean
  defaultOptions?: ClientDefaultOptions
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Client implements IClient {
  private _sdkClient: SdkClient | null = null
  private _refCount = 0
  private _connectPromise: Promise<void> | null = null

  private readonly _input: ClientTransportInput
  private readonly _auth: BearerAuth | OAuth | ClientCredentials | undefined
  private readonly _handlers: Required<Omit<ClientHandlers, 'sampling' | 'elicitation'>> &
    Pick<ClientHandlers, 'sampling' | 'elicitation'>
  private readonly _roots: string[] | undefined
  private readonly _autoInitialize: boolean
  private readonly _defaultOptions: ClientDefaultOptions

  constructor(input: ClientTransportInput, options?: ClientOptions) {
    this._input = input
    this._auth = resolveAuth(options?.auth)
    this._handlers = {
      log: options?.handlers?.log ?? defaultLogHandler,
      progress: options?.handlers?.progress ?? defaultProgressHandler,
      sampling: options?.handlers?.sampling,
      elicitation: options?.handlers?.elicitation,
    }
    this._roots = options?.roots
    this._autoInitialize = options?.autoInitialize ?? true
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
      { capabilities: this._buildCapabilities() },
    )

    this._registerHandlers(sdkClient)

    const { transport, beforeConnect } = resolveTransport(this._input, this._auth)

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
        // Wait for the callback server to receive the code, then finish auth
        // and retry the connection.
        const code = await this._auth.waitForCallback()
        if (
          'finishAuth' in transport &&
          typeof (transport as Record<string, unknown>).finishAuth === 'function'
        ) {
          await (transport as { finishAuth(code: string): Promise<void> }).finishAuth(
            code,
          )
        }
        await sdkClient.connect(transport)
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

  /** Creates a connected Client. Use with `await using` for automatic cleanup. */
  static async connect(
    input: ClientTransportInput,
    options?: ClientOptions,
  ): Promise<Client> {
    const client = new Client(input, options)
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

  async readResource(uri: string, options?: RequestOptions): Promise<ResourceContents[]> {
    const result = await this._sdk().readResource(
      { uri },
      this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
    )
    return result.contents as ResourceContents[]
  }

  /** Returns the raw SDK ReadResourceResult without unwrapping. */
  async readResourceRaw(uri: string, options?: RequestOptions) {
    return this._sdk().readResource(
      { uri },
      this._toSdkOptions(options, undefined, this._defaultOptions.resource?.timeout),
    )
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
      ...(this._roots ? { roots: { listChanged: false } } : {}),
    }
  }

  private _registerHandlers(sdk: SdkClient): void {
    // Log notifications from the server
    sdk.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      void this._handlers.log({
        level: notification.params.level,
        logger: notification.params.logger ?? undefined,
        data: notification.params.data,
      })
    })

    // Sampling: server requests an LLM completion from the client
    if (this._handlers.sampling) {
      const samplingHandler = this._handlers.sampling
      sdk.setRequestHandler(CreateMessageRequestSchema, async (request) => {
        return samplingHandler(request.params)
      })
    }

    // Elicitation: server requests structured user input
    if (this._handlers.elicitation) {
      const elicitationHandler = this._handlers.elicitation
      sdk.setRequestHandler(ElicitRequestSchema, async (request) => {
        return elicitationHandler(request.params)
      })
    }

    // Roots: server requests the client's accessible filesystem roots
    if (this._roots) {
      const roots = this._roots
      sdk.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: roots.map((uri) => ({ uri })),
      }))
    }
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
