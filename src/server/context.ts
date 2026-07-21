import { AsyncLocalStorage } from 'node:async_hooks'
import type { Server } from '@modelcontextprotocol/server'
import type { AccessToken } from './auth/types'

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency'

export interface SamplingMessage {
  role: 'user' | 'assistant'
  content:
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
}

export interface SamplingParams {
  messages: SamplingMessage[]
  systemPrompt?: string
  /** Maximum tokens to generate. Defaults to 1024. */
  maxTokens?: number
  temperature?: number
  stopSequences?: string[]
  modelPreferences?: {
    hints?: Array<{ name?: string }>
    costPriority?: number
    speedPriority?: number
    intelligencePriority?: number
  }
}

export interface SamplingResult {
  role: 'assistant'
  content:
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  model: string
  stopReason?: string
}

/**
 * Flat JSON Schema object describing fields to collect from the user.
 * Only primitive property types (string, number, boolean) are allowed per the MCP spec.
 */
export interface ElicitationSchema {
  type: 'object'
  properties: Record<
    string,
    { type: 'string' | 'number' | 'boolean'; title?: string; description?: string }
  >
  required?: string[]
}

export interface ElicitationResult {
  /** How the user responded to the elicitation. */
  action: 'accept' | 'decline' | 'cancel'
  /** Submitted form values. Present only when action is 'accept'. */
  content?: Record<string, string | number | boolean>
}

export interface Root {
  uri: string
  name?: string
}

// ---------------------------------------------------------------------------
// McpContext — public interface returned by mcp.getContext()
// ---------------------------------------------------------------------------

export interface McpContext {
  /** Auth token for the current request, if any. */
  auth: AccessToken | undefined
  /** The MCP request ID for the current call. */
  requestId: string | undefined

  // --- Logging ---

  /** Send a log message to the client at the specified RFC 5424 severity level. */
  log(level: LogLevel, message: string, loggerName?: string): Promise<void>
  debug(message: string, loggerName?: string): Promise<void>
  info(message: string, loggerName?: string): Promise<void>
  notice(message: string, loggerName?: string): Promise<void>
  warning(message: string, loggerName?: string): Promise<void>
  error(message: string, loggerName?: string): Promise<void>
  critical(message: string, loggerName?: string): Promise<void>
  alert(message: string, loggerName?: string): Promise<void>
  emergency(message: string, loggerName?: string): Promise<void>

  // --- Progress ---

  /**
   * Send a progress notification to the client.
   * No-op if the request did not include a `progressToken` in its `_meta`.
   */
  reportProgress(progress: number, total?: number, message?: string): Promise<void>

  // --- Sampling ---

  /**
   * Ask the client to perform an LLM inference call and return the result.
   * Throws if the client has not advertised the `sampling` capability.
   */
  sample(params: SamplingParams): Promise<SamplingResult>

  // --- Elicitation ---

  /**
   * Ask the client to collect input from the user via a form dialog.
   * Throws if the client has not advertised the `elicitation` capability.
   */
  elicit(message: string, schema: ElicitationSchema): Promise<ElicitationResult>

  // --- Roots ---

  /**
   * Request the list of filesystem roots the client has declared.
   * Throws if the client has not advertised the `roots` capability.
   */
  listRoots(): Promise<Root[]>

  // --- Session state ---

  /** Retrieve a value from session-scoped state. Returns undefined if not set. */
  getState(key: string): unknown
  /** Store a value in session-scoped state. Persists for the lifetime of the session. */
  setState(key: string, value: unknown): void
  /** Remove a value from session-scoped state. */
  deleteState(key: string): void

  // --- Apps ---

  /**
   * Resolve a logical tool name to its current external name, accounting for
   * any namespace prefix applied when the owning FastMCPApp was mounted.
   * Returns the name unchanged when called outside a mounted context.
   */
  resolveToolName(name: string): string

  // --- Session lifecycle ---

  /**
   * Register a callback that runs when the current session closes.
   * Useful for releasing per-session resources (e.g. uploaded files).
   * No-op if called outside an active HTTP session.
   */
  onClose(callback: () => void): void
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage store
// ---------------------------------------------------------------------------

export const contextStore = new AsyncLocalStorage<McpContext>()

/** Internal session-state key for per-session close callbacks. */
export const SESSION_CLOSE_CALLBACKS_KEY = '__fastmcp_session_close_callbacks'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a McpContext for a single request.
 *
 * @param server      The SDK Server instance for this session.
 * @param requestId   The MCP request ID from the incoming message.
 * @param progressToken  The progress token from `req.params._meta.progressToken`, if any.
 * @param auth        The verified access token, if any.
 * @param sessionState  The per-session state Map (shared across requests in the same session).
 */
export function createContext(
  server: Server,
  requestId: string | undefined,
  progressToken: string | number | undefined,
  auth: AccessToken | undefined,
  sessionState: Map<string, unknown>,
): McpContext {
  async function log(level: LogLevel, message: string, loggerName?: string): Promise<void> {
    await server.sendLoggingMessage({
      level,
      data: message,
      ...(loggerName !== undefined ? { logger: loggerName } : {}),
    })
  }

  return {
    auth,
    requestId,

    log,
    debug: (msg, logger) => log('debug', msg, logger),
    info: (msg, logger) => log('info', msg, logger),
    notice: (msg, logger) => log('notice', msg, logger),
    warning: (msg, logger) => log('warning', msg, logger),
    error: (msg, logger) => log('error', msg, logger),
    critical: (msg, logger) => log('critical', msg, logger),
    alert: (msg, logger) => log('alert', msg, logger),
    emergency: (msg, logger) => log('emergency', msg, logger),

    async reportProgress(progress, total, message) {
      if (progressToken === undefined) return
      await server.notification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
        },
      })
    },

    async sample(params) {
      const caps = server.getClientCapabilities()
      if (!caps?.sampling) {
        throw new Error(
          '[fastmcp] Client does not support sampling. Ensure the client advertises the sampling capability before calling ctx.sample().',
        )
      }
      const result = await server.createMessage({
        messages: params.messages,
        maxTokens: params.maxTokens ?? 1024,
        ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.stopSequences !== undefined ? { stopSequences: params.stopSequences } : {}),
        ...(params.modelPreferences !== undefined
          ? { modelPreferences: params.modelPreferences }
          : {}),
      })
      return {
        role: 'assistant' as const,
        content: result.content as SamplingResult['content'],
        model: result.model,
        stopReason: result.stopReason,
      }
    },

    async elicit(message, schema) {
      const caps = server.getClientCapabilities()
      if (!caps?.elicitation) {
        throw new Error(
          '[fastmcp] Client does not support elicitation. Ensure the client advertises the elicitation capability before calling ctx.elicit().',
        )
      }
      const result = await server.elicitInput({
        message,
        // Cast: our simplified ElicitationSchema is a subset of the SDK's PrimitiveSchemaDefinition union
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        requestedSchema: schema as any,
      })
      return {
        action: result.action,
        content: result.content as ElicitationResult['content'],
      }
    },

    async listRoots() {
      const caps = server.getClientCapabilities()
      if (!caps?.roots) {
        throw new Error(
          '[fastmcp] Client does not support roots. Ensure the client advertises the roots capability before calling ctx.listRoots().',
        )
      }
      const result = await server.listRoots()
      return result.roots
    },

    getState: (key) => sessionState.get(key),
    setState: (key, value) => {
      sessionState.set(key, value)
    },
    deleteState: (key) => {
      sessionState.delete(key)
    },

    resolveToolName: (name) => name,

    onClose(callback) {
      const existing = (sessionState.get(SESSION_CLOSE_CALLBACKS_KEY) as Array<() => void> | undefined) ?? []
      sessionState.set(SESSION_CLOSE_CALLBACKS_KEY, [...existing, callback])
    },
  }
}
