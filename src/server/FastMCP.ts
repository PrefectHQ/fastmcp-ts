import { Server } from '@modelcontextprotocol/sdk/server'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types'
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthorizationError } from './auth/types'
import type { TokenVerifier, AccessToken } from './auth/types'
import type { AuthCheck } from './auth/authorization'
import { contextStore } from './context'
import type { McpContext } from './context'
import { convertResult, toJsonSchema, validateInput } from './tool'

/** Convert a camelCase or PascalCase identifier to a human-readable description. */
function inferDescription(name: string): string {
  return name.replace(/([A-Z])/g, ' $1').toLowerCase().trim()
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
  /** Tool name. If omitted, inferred from the handler function's name. */
  name?: string
  description?: string
  /** Standard Schema validator for the tool's input arguments. Used for runtime validation. */
  input?: StandardSchemaV1
  /**
   * Explicit JSON Schema advertised to clients as `inputSchema`. Overrides auto-generation from
   * `input`. Use this when `input` is not a Zod v4 schema and auto-generation falls back to
   * `{ type: 'object' }`.
   */
  inputSchema?: Record<string, unknown>
  /** Standard Schema validator for the tool's return value. Validated before result conversion. */
  output?: StandardSchemaV1
  /**
   * Explicit JSON Schema advertised to clients as `outputSchema`. Overrides auto-generation from
   * `output`.
   */
  outputSchema?: Record<string, unknown>
  /** Execution timeout in milliseconds. No timeout by default. */
  timeout?: number
  /** When true the tool is hidden from listTools and cannot be invoked via tools/call. */
  disabled?: boolean
  /** Arbitrary tags for server-side filtering. */
  tags?: string[]
  auth?: AuthCheck
}

export interface ResourceConfig {
  name: string
  uri: string
  description?: string
  mimeType?: string
  auth?: AuthCheck
}

interface RegisteredTool {
  config: ToolConfig & { name: string }
  handler: (args: unknown) => unknown
}

interface RegisteredResource {
  config: ResourceConfig
  handler: () => unknown
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: Server
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

async function runAuthCheck(check: AuthCheck, token: AccessToken | undefined): Promise<void> {
  if (!token) throw new McpError(ErrorCode.InvalidRequest, 'Authentication required')
  try {
    await check(token)
  } catch (err) {
    if (err instanceof AuthorizationError) {
      throw new McpError(ErrorCode.InvalidRequest, err.message)
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
  private _tools = new Map<string, RegisteredTool>()
  private _resources = new Map<string, RegisteredResource>()
  private _httpServer: HttpServer | null = null
  private _address: ServerAddress | null = null
  private _sessions = new Map<string, Session>()
  // Primary server used by connect() and stdio
  private _primaryServer: Server

  constructor(options: FastMCPOptions) {
    this.name = options.name
    this.version = options.version ?? '0.0.1'
    this._auth = options.auth
    this._oauth = options.oauth
    this._toolsPageSize = options.toolsPageSize ?? 50
    this._primaryServer = this._makeServer()
  }

  /** Create a new Server instance with all request handlers wired up. */
  private _makeServer(): Server {
    const server = new Server(
      { name: this.name, version: this.version },
      { capabilities: { tools: {}, resources: {} } },
    )
    this._setupHandlers(server)
    return server
  }

  private _setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const token = toAccessToken(extra.authInfo)
      const allVisible = (
        await Promise.all(
          [...this._tools.values()].map(async (t) => {
            if (t.config.disabled) return null
            if (!t.config.auth) return t
            if (!token) return null
            try {
              await t.config.auth(token)
              return t
            } catch {
              return null
            }
          }),
        )
      ).filter((t): t is RegisteredTool => t !== null)

      // Cursor-based pagination
      const pageSize = this._toolsPageSize
      const cursorName = req.params?.cursor
        ? Buffer.from(req.params.cursor, 'base64url').toString()
        : null
      let startIdx = 0
      if (cursorName !== null) {
        const idx = allVisible.findIndex((t) => t.config.name === cursorName)
        startIdx = idx >= 0 ? idx + 1 : 0
      }
      const page = allVisible.slice(startIdx, startIdx + pageSize)
      const nextCursor =
        startIdx + pageSize < allVisible.length
          ? Buffer.from(page[page.length - 1].config.name).toString('base64url')
          : undefined

      const tools = await Promise.all(
        page.map(async (t) => {
          const inputSchema =
            t.config.inputSchema ??
            (t.config.input
              ? await toJsonSchema(t.config.input, `tool "${t.config.name}" input`)
              : { type: 'object' as const })
          const outputSchema =
            t.config.outputSchema ??
            (t.config.output
              ? await toJsonSchema(t.config.output, `tool "${t.config.name}" output`)
              : undefined)
          return {
            name: t.config.name,
            description: t.config.description,
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
          }
        }),
      )

      return { tools, ...(nextCursor ? { nextCursor } : {}) }
    })

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const tool = this._tools.get(req.params.name)
      if (!tool || tool.config.disabled) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: "${req.params.name}"`)
      }

      const token = toAccessToken(extra.authInfo)
      if (tool.config.auth) await runAuthCheck(tool.config.auth, token)

      const rawArgs: unknown = req.params.arguments ?? {}
      const ctx: McpContext = { auth: token }

      try {
        const args = tool.config.input ? await validateInput(tool.config.input, rawArgs) : rawArgs

        let executePromise: Promise<unknown> = contextStore.run(ctx, async () =>
          tool.handler(args),
        )

        if (tool.config.timeout) {
          const ms = tool.config.timeout
          let timer!: ReturnType<typeof setTimeout>
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Tool "${req.params.name}" timed out after ${ms}ms`)),
              ms,
            )
          })
          executePromise = Promise.race([executePromise, timeoutPromise]).finally(() =>
            clearTimeout(timer),
          )
        }

        let resultValue = await executePromise

        // Validate output schema against the raw handler return value
        if (tool.config.output) {
          resultValue = await validateInput(tool.config.output, resultValue)
        }

        return convertResult(resultValue)
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
        }
      }
    })

    server.setRequestHandler(ListResourcesRequestSchema, async (_req, extra) => {
      const token = toAccessToken(extra.authInfo)
      const visible = await Promise.all(
        [...this._resources.values()].map(async (r) => {
          if (!r.config.auth) return r
          if (!token) return null
          try {
            await r.config.auth(token)
            return r
          } catch {
            return null
          }
        }),
      )
      return {
        resources: visible
          .filter((r): r is RegisteredResource => r !== null)
          .map((r) => ({
            uri: r.config.uri,
            name: r.config.name,
            description: r.config.description,
            mimeType: r.config.mimeType,
          })),
      }
    })

    server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
      const resource = this._resources.get(req.params.uri)
      if (!resource) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown resource: "${req.params.uri}"`)
      }

      const token = toAccessToken(extra.authInfo)
      if (resource.config.auth) await runAuthCheck(resource.config.auth, token)

      const ctx: McpContext = { auth: token }
      const result = await contextStore.run(ctx, () => resource.handler())

      return {
        contents: [
          {
            uri: req.params.uri,
            mimeType: resource.config.mimeType ?? 'text/plain',
            text: String(result ?? ''),
          },
        ],
      }
    })
  }

  private _notifyToolListChanged(): void {
    this._primaryServer.sendToolListChanged().catch(() => {})
    for (const { server } of this._sessions.values()) {
      server.sendToolListChanged().catch(() => {})
    }
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
    const name = config.name ?? (handler as { name?: string }).name
    if (!name) {
      throw new Error(
        'Tool name must be provided in config or inferrable from the handler function name',
      )
    }
    const description = config.description ?? inferDescription(name)
    const resolvedConfig = { ...config, name, description }
    this._tools.set(name, { config: resolvedConfig, handler })
    this._notifyToolListChanged()
  }

  resource(config: ResourceConfig, handler: ResourceHandler): void {
    this._resources.set(config.uri, { config, handler })
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

  async connect(transport: Transport): Promise<void> {
    await this._primaryServer.connect(transport)
  }

  async run(options?: RunOptions): Promise<void> {
    const rawTransport = options?.transport ?? process.env.MCP_TRANSPORT ?? 'stdio'
    if (rawTransport !== 'stdio' && rawTransport !== 'http') {
      throw new Error(`Unknown transport: "${rawTransport}". Supported: stdio, http.`)
    }
    const transport = rawTransport as 'stdio' | 'http'

    const port = options?.port ?? parseInt(process.env.MCP_PORT ?? process.env.PORT ?? '3000', 10)
    const host = options?.host ?? process.env.MCP_HOST ?? '0.0.0.0'
    const path = options?.path ?? process.env.MCP_PATH ?? '/mcp'

    if (transport === 'stdio') {
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio')
      await this.connect(new StdioServerTransport(options?.stdin, options?.stdout))
    } else if (this._oauth) {
      await this._runHttpOAuth(port, host, path)
    } else {
      await this._runHttpSimple(port, host, path)
    }
  }

  private async _runHttpOAuth(port: number, host: string, path: string): Promise<void> {
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp'
    )
    const express = (await import('express')).default
    const { mcpAuthRouter } = await import('@modelcontextprotocol/sdk/server/auth/router')
    const { requireBearerAuth } = await import(
      '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth'
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

    // MCP endpoint — protected by bearer auth
    app.all(
      path,
      requireBearerAuth({ verifier: oauth.provider }),
      async (req, res, _next) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        let mcpTransport: StreamableHTTPServerTransport

        if (sessionId) {
          const existing = this._sessions.get(sessionId)
          if (!existing) {
            res.status(404).json({ error: 'Session not found' })
            return
          }
          mcpTransport = existing.transport
        } else {
          const sessionServer = this._makeServer()
          mcpTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              this._sessions.set(id, { transport: mcpTransport, server: sessionServer })
            },
            onsessionclosed: (id) => {
              this._sessions.delete(id)
            },
          })
          await sessionServer.connect(mcpTransport)
        }

        await mcpTransport.handleRequest(req, res)
      },
    )

    this._httpServer = httpServer
    this._address = { host: bound.address, port: bound.port, path }
  }

  private async _runHttpSimple(port: number, host: string, path: string): Promise<void> {
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp'
    )
    const { createServer } = await import('node:http')

    const auth = this._auth

    const httpServer = createServer(async (req, res) => {
      if (req.url?.split('?')[0] !== path) {
        res.writeHead(404).end()
        return
      }

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

      // Session routing: each client connection gets its own transport + server
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let mcpTransport: StreamableHTTPServerTransport

      if (sessionId) {
        const existing = this._sessions.get(sessionId)
        if (!existing) {
          res
            .writeHead(404, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'Session not found' }))
          return
        }
        mcpTransport = existing.transport
      } else {
        const sessionServer = this._makeServer()
        mcpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this._sessions.set(id, { transport: mcpTransport, server: sessionServer })
          },
          onsessionclosed: (id) => {
            this._sessions.delete(id)
          },
        })
        await sessionServer.connect(mcpTransport)
      }

      await mcpTransport.handleRequest(req, res)
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
    // Close all active HTTP sessions
    await Promise.all(
      [...this._sessions.values()].map(({ transport }) => transport.close().catch(() => {})),
    )
    this._sessions.clear()

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

type ResourceHandler = () => unknown
