import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport'
import { normalizeHeaders } from '@modelcontextprotocol/sdk/shared/transport'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import { OAuth, type BearerAuth, type ClientCredentials } from './auth.js'

// ---------------------------------------------------------------------------
// McpServerLike — structural interface for in-process servers.
// Intentionally loose: avoids importing from the server module.
// ---------------------------------------------------------------------------

export interface McpServerLike {
  connect(transport: Transport): Promise<void>
}

function isMcpServerLike(value: unknown): value is McpServerLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'connect' in value &&
    typeof (value as Record<string, unknown>).connect === 'function'
  )
}

// ---------------------------------------------------------------------------
// MCP config object — { mcpServers: { name: { url | command, ... } } }
// ---------------------------------------------------------------------------

export type McpServerEntry =
  | { url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> }

export type McpConfig = {
  mcpServers: Record<string, McpServerEntry>
}

function isMcpConfig(value: unknown): value is McpConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'mcpServers' in value &&
    typeof (value as McpConfig).mcpServers === 'object' &&
    (value as McpConfig).mcpServers !== null
  )
}

// ---------------------------------------------------------------------------
// StdioTransport — configuration object for stdio subprocess connections.
// Separate from the SDK's StdioClientTransport so callers work with a plain
// config value rather than a live transport instance.
// ---------------------------------------------------------------------------

export class StdioTransport {
  readonly command: string
  readonly args: string[]
  readonly env?: Record<string, string>
  readonly cwd?: string

  constructor(
    command: string,
    args: string[] = [],
    options?: { env?: Record<string, string>; cwd?: string },
  ) {
    this.command = command
    this.args = args
    this.env = options?.env
    this.cwd = options?.cwd
  }
}

// ---------------------------------------------------------------------------
// ClientTransportInput — what the Client constructor accepts
// ---------------------------------------------------------------------------

export type ClientTransportInput =
  | string         // HTTP/HTTPS URL → auto-detect Streamable HTTP or SSE
  | McpServerLike  // in-process server instance
  | McpConfig      // { mcpServers: { ... } } config object
  | StdioTransport // explicit stdio subprocess config
  | Transport      // pass-through — any SDK Transport (advanced)

// ---------------------------------------------------------------------------
// Resolved transport — what Client.connect() receives
// ---------------------------------------------------------------------------

export type ResolvedTransport = {
  transport: Transport
  /**
   * Called before sdkClient.connect(transport). Used for in-process servers
   * that must be connected to their side of the InMemoryTransport first.
   */
  beforeConnect?: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Auth header injection helpers
// ---------------------------------------------------------------------------

function isAsyncAuth(
  auth: BearerAuth | OAuth | ClientCredentials,
): auth is ClientCredentials {
  // Only ClientCredentials uses async per-request injection.
  // OAuth is now an OAuthClientProvider and is passed directly to the transport.
  return 'kind' in auth
}

type HttpTransportOptions = {
  requestInit?: RequestInit
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>
  eventSourceInit?: Record<string, unknown>
  authProvider?: OAuthClientProvider
}

function buildHttpOptions(
  auth: BearerAuth | OAuth | ClientCredentials | undefined,
  extraHeaders: Record<string, string> = {},
): HttpTransportOptions {
  const hasExtra = Object.keys(extraHeaders).length > 0

  if (!auth && !hasExtra) return {}

  // OAuth implements OAuthClientProvider — hand it to the SDK transport which
  // handles the full auth flow (discovery, DCR, PKCE, token refresh, 401 retry).
  if (auth instanceof OAuth) {
    const opts: HttpTransportOptions = { authProvider: auth }
    // Extra headers are injected via requestInit (not Authorization — that's
    // managed by the authProvider).
    if (hasExtra) opts.requestInit = { headers: extraHeaders }
    return opts
  }

  if (auth && isAsyncAuth(auth)) {
    // ClientCredentials: inject token per-request via a custom fetch wrapper.
    const customFetch = async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const authHeaders = await auth.getHeaders()
      return fetch(url, {
        ...init,
        headers: {
          ...authHeaders,
          ...extraHeaders,
          ...normalizeHeaders(init?.headers),
        },
      })
    }
    return { fetch: customFetch }
  }

  // Static auth (BearerAuth) or extra headers only.
  const staticHeaders: Record<string, string> = {
    ...(auth ? auth.getHeaders() : {}),
    ...extraHeaders,
  }
  return {
    requestInit: { headers: staticHeaders },
    // Also exposed for SSE's EventSource connection (eventsource npm pkg
    // accepts headers in EventSourceInit, unlike the browser API).
    eventSourceInit: { headers: staticHeaders },
  }
}

// ---------------------------------------------------------------------------
// URL → SDK transport
// ---------------------------------------------------------------------------

function urlToTransport(
  url: URL,
  auth: BearerAuth | OAuth | ClientCredentials | undefined,
  extraHeaders: Record<string, string> = {},
): Transport {
  const { requestInit, fetch: customFetch, eventSourceInit, authProvider } =
    buildHttpOptions(auth, extraHeaders)

  const segments = url.pathname.split('/')
  const isSSE = segments.includes('sse') || url.pathname.endsWith('/sse')

  if (isSSE) {
    return new SSEClientTransport(url, {
      ...(authProvider ? { authProvider } : {}),
      ...(requestInit ? { requestInit } : {}),
      ...(eventSourceInit ? { eventSourceInit } : {}),
      ...(customFetch ? { fetch: customFetch } : {}),
    })
  }

  return new StreamableHTTPClientTransport(url, {
    ...(authProvider ? { authProvider } : {}),
    ...(requestInit ? { requestInit } : {}),
    ...(customFetch ? { fetch: customFetch } : {}),
  })
}

// ---------------------------------------------------------------------------
// resolveTransport — internal; used by Client.connect()
// ---------------------------------------------------------------------------

export function resolveTransport(
  input: ClientTransportInput,
  auth?: BearerAuth | OAuth | ClientCredentials,
): ResolvedTransport {
  // 1. Our StdioTransport config class (check before the duck-type checks below).
  if (input instanceof StdioTransport) {
    return {
      transport: new StdioClientTransport({
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: input.cwd,
      }),
    }
  }

  // 2. URL string → auto-detect HTTP transport.
  if (typeof input === 'string') {
    const url = new URL(input)
    return { transport: urlToTransport(url, auth) }
  }

  // 3. Pass-through SDK Transport (has the Transport interface: start/close/send).
  if (
    typeof input === 'object' &&
    input !== null &&
    'start' in input &&
    typeof (input as unknown as Record<string, unknown>).start === 'function'
  ) {
    return { transport: input as Transport }
  }

  // 4. MCP config object { mcpServers: { ... } }.
  if (isMcpConfig(input)) {
    const entries = Object.entries(input.mcpServers)
    if (entries.length === 0) throw new Error('mcpServers config is empty')
    const [, entry] = entries[0]!

    if ('url' in entry) {
      const url = new URL(entry.url)
      const extraHeaders = entry.headers ?? {}
      return { transport: urlToTransport(url, auth, extraHeaders) }
    }

    return {
      transport: new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: entry.env,
      }),
    }
  }

  // 5. In-process server (McpServerLike: has connect(transport)).
  if (isMcpServerLike(input)) {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    return {
      transport: clientSide,
      beforeConnect: () => input.connect(serverSide),
    }
  }

  throw new Error(
    'Unrecognized transport input: expected a URL string, FastMCP server instance, ' +
    'mcpServers config object, StdioTransport, or SDK Transport',
  )
}
