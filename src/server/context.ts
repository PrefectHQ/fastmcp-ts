import { AsyncLocalStorage } from 'node:async_hooks'
import type { Server, ServerContext, RequestStateCodec } from '@modelcontextprotocol/server'
import type { AccessToken } from './auth/types'
import type { InputResponses } from './mrtr'

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
   *
   * @deprecated Sampling is deprecated as of protocol revision 2026-07-28 (SEP-2577)
   * and this push-style call only works on a legacy (2025-era) connection — calling it
   * on a modern request throws a clear error naming the replacement (return
   * `inputRequired({ inputRequests: { id: inputRequired.createMessage({...}) } })` from
   * the handler instead; see `fastmcp-ts/server`'s re-exported `inputRequired`). A
   * handler written the `inputRequired` way serves both eras unchanged — the SDK's
   * legacy shim fulfils it via a real server→client request on 2025-era connections, so
   * there is rarely a reason to keep calling `ctx.sample()` directly in new code.
   */
  sample(params: SamplingParams): Promise<SamplingResult>

  // --- Elicitation ---

  /**
   * Ask the client to collect input from the user via a form dialog.
   * Throws if the client has not advertised the `elicitation` capability.
   *
   * @deprecated Throws a clear error naming the replacement when called on a modern
   * (2026-07-28) request — return `inputRequired({ inputRequests: { id:
   * inputRequired.elicit({...}) } })` instead (see `ctx.sample`'s docs; the same
   * write-once, serve-both-eras guidance applies).
   */
  elicit(message: string, schema: ElicitationSchema): Promise<ElicitationResult>

  // --- Roots ---

  /**
   * Request the list of filesystem roots the client has declared.
   * Throws if the client has not advertised the `roots` capability.
   *
   * @deprecated Roots is deprecated as of protocol revision 2026-07-28 (SEP-2577) —
   * prefer passing paths via tool parameters, resource URIs, or server configuration.
   * Throws a clear error naming `inputRequired(...)` as the multi-round-trip
   * replacement when called on a modern request (see `ctx.sample`'s docs).
   */
  listRoots(): Promise<Root[]>

  // --- Multi-round-trip requests (MRTR, protocol revision 2026-07-28) ---

  /**
   * The current round's embedded input responses, when this request is a retry of an
   * earlier `inputRequired(...)` return. `undefined` on the flow's first call (no
   * prior round to respond to). Read with the SDK's `acceptedContent(ctx.inputResponses,
   * key)` / `inputResponse(ctx.inputResponses, key)` (re-exported from
   * `fastmcp-ts/server`) rather than indexing this object directly — those readers
   * validate shape and, for `acceptedContent`, optionally the content against a schema.
   */
  inputResponses: InputResponses | undefined

  /**
   * Reads the current round's `requestState`, already verified and decoded when
   * `FastMCPOptions.requestState` is configured (the payload `verify` resolved with);
   * the raw, unverified wire string when it is not configured — treat that case as
   * attacker-controlled input. `undefined` when the round carried no state.
   */
  requestState<T = unknown>(): T | undefined

  /**
   * Seals `payload` into the opaque `requestState` string to return from
   * `inputRequired({ requestState })`. HMAC-signed via `FastMCPOptions.requestState`
   * when configured; otherwise a plain `JSON.stringify(payload)` with a one-time
   * console warning — the resulting state is unsigned and MUST NOT be trusted for
   * anything that influences authorization, resource access, or business logic (the
   * client can read and tamper with it) unless `FastMCPOptions.requestState` is set.
   */
  mintRequestState<T = unknown>(payload: T): Promise<string>

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

/**
 * Pointed error thrown by `ctx.getState` / `ctx.setState` / `ctx.deleteState` on a
 * modern (2026-07-28) HTTP request. Plan §3: session state stays for stdio and legacy
 * HTTP sessions; on modern HTTP every accessor throws instead of silently dropping the
 * read/write/delete against a fresh per-request state map. The message steers to the
 * request-scoped replacement.
 */
const SESSION_STATE_MODERN_HTTP_ERROR =
  '[fastmcp] Session state is not available on modern HTTP requests (protocol revision 2026-07-28). ' +
  'Each request runs statelessly with no shared session store. ' +
  'Use ctx.requestState() to read per-request state. ' +
  'Use ctx.mintRequestState() to carry state across a multi-round-trip flow.'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a McpContext for a single request.
 *
 * @param server   The SDK Server instance for this session.
 * @param sdkCtx   The SDK's own per-request ServerContext (the second argument passed to
 *                 every `server.setRequestHandler` callback). Supplies the request ID,
 *                 progress token, and — critically — `mcpReq.log` / `mcpReq.notify`, which
 *                 route era-appropriately: on a legacy (2025-era) connection they behave
 *                 exactly like the old `server.sendLoggingMessage` / `server.notification`
 *                 push; on a modern (2026-07-28) request, logging is gated on the
 *                 per-request `_meta` `logLevel` envelope key (absent = suppressed, not
 *                 unfiltered — see `ctx.log`'s own docs) and progress/related messages are
 *                 correctly attached to the current request's response (single JSON body
 *                 or SSE stream) rather than pushed as a request-agnostic notification.
 * @param auth     The verified access token, if any.
 * @param sessionState  The per-session state Map (shared across requests in the same session).
 * @param requestStateCodec  The HMAC codec built from `FastMCPOptions.requestState`, if
 *   configured. Backs `ctx.mintRequestState()`; `ctx.requestState()` itself always reads
 *   through `sdkCtx.mcpReq.requestState()`, which already reflects whatever
 *   `ServerOptions.requestState.verify` (built from this same codec) resolved.
 */
export function createContext(
  server: Server,
  sdkCtx: ServerContext,
  auth: AccessToken | undefined,
  sessionState: Map<string, unknown>,
  requestStateCodec?: RequestStateCodec,
): McpContext {
  const requestId = String(sdkCtx.mcpReq.id)
  const progressToken = (sdkCtx.mcpReq._meta as { progressToken?: string | number } | undefined)
    ?.progressToken

  // Per-request era + transport, read from the SDK context:
  //  - a modern (2026-07-28) request carries a `_meta` envelope; a legacy one does not.
  //  - an HTTP-transport request carries `sdkCtx.http`; a stdio one does not.
  // These back the era gates below. `isModernEra` reorders the sample/elicit/listRoots
  // capability guard (Req 2); `isModernHttpRequest` gates session state (Req 1).
  const isModernEra = sdkCtx.mcpReq.envelope !== undefined
  const isModernHttpRequest = isModernEra && sdkCtx.http !== undefined

  async function log(level: LogLevel, message: string, loggerName?: string): Promise<void> {
    await sdkCtx.mcpReq.log(level, message, loggerName)
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
      await sdkCtx.mcpReq.notify({
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
      // On a modern (2026-07-28) request there is no server→client channel: skip the
      // legacy capability guard so the SDK's era gate throws first, naming the
      // inputRequired(...) replacement. On legacy the capability guard stays intact
      // (getClientCapabilities reflects the initialize handshake). (task-9 Req 2)
      if (!isModernEra) {
        const caps = server.getClientCapabilities()
        if (!caps?.sampling) {
          throw new Error(
            '[fastmcp] Client does not support sampling. Ensure the client advertises the sampling capability before calling ctx.sample().',
          )
        }
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
      // Modern era: skip the legacy capability guard so the SDK era gate throws first,
      // naming inputRequired(...). Legacy: capability guard intact. (task-9 Req 2)
      if (!isModernEra) {
        const caps = server.getClientCapabilities()
        if (!caps?.elicitation) {
          throw new Error(
            '[fastmcp] Client does not support elicitation. Ensure the client advertises the elicitation capability before calling ctx.elicit().',
          )
        }
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
      // Modern era: skip the legacy capability guard so the SDK era gate throws first,
      // naming inputRequired(...). Legacy: capability guard intact. (task-9 Req 2)
      if (!isModernEra) {
        const caps = server.getClientCapabilities()
        if (!caps?.roots) {
          throw new Error(
            '[fastmcp] Client does not support roots. Ensure the client advertises the roots capability before calling ctx.listRoots().',
          )
        }
      }
      const result = await server.listRoots()
      return result.roots
    },

    inputResponses: sdkCtx.mcpReq.inputResponses as InputResponses | undefined,

    requestState: <T = unknown>() => sdkCtx.mcpReq.requestState<T>(),

    async mintRequestState<T = unknown>(payload: T): Promise<string> {
      if (requestStateCodec) return requestStateCodec.mint(payload, sdkCtx)
      console.warn(
        '[fastmcp] ctx.mintRequestState() called without FastMCPOptions.requestState configured — ' +
          'the resulting requestState is unsigned. Configure FastMCPOptions.requestState for any ' +
          'state that influences authorization, resource access, or business logic.',
      )
      return JSON.stringify(payload)
    },

    getState: (key) => {
      if (isModernHttpRequest) throw new Error(SESSION_STATE_MODERN_HTTP_ERROR)
      return sessionState.get(key)
    },
    setState: (key, value) => {
      if (isModernHttpRequest) throw new Error(SESSION_STATE_MODERN_HTTP_ERROR)
      sessionState.set(key, value)
    },
    deleteState: (key) => {
      if (isModernHttpRequest) throw new Error(SESSION_STATE_MODERN_HTTP_ERROR)
      sessionState.delete(key)
    },

    resolveToolName: (name) => name,

    onClose(callback) {
      const existing = (sessionState.get(SESSION_CLOSE_CALLBACKS_KEY) as Array<() => void> | undefined) ?? []
      sessionState.set(SESSION_CLOSE_CALLBACKS_KEY, [...existing, callback])
    },
  }
}
