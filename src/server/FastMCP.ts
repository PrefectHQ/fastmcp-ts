import { Server } from '@modelcontextprotocol/sdk/server'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types'
import { AuthorizationError } from './auth/types'
import type { TokenVerifier } from './auth/types'

export interface FastMCPOptions {
  name: string
  version?: string
  auth?: TokenVerifier
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

export class FastMCP {
  readonly name: string
  readonly version: string

  private _server: Server
  private _auth: TokenVerifier | undefined
  private _httpServer: HttpServer | null = null
  private _address: ServerAddress | null = null

  constructor(options: FastMCPOptions) {
    this.name = options.name
    this.version = options.version ?? '0.0.1'
    this._auth = options.auth

    this._server = new Server(
      { name: this.name, version: this.version },
      { capabilities: {} },
    )
  }

  /** The bound address after run() resolves for the http transport. Null for stdio or before run(). */
  get address(): ServerAddress | null {
    return this._address
  }

  async connect(transport: Transport): Promise<void> {
    await this._server.connect(transport)
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
    } else {
      const { StreamableHTTPServerTransport } = await import(
        '@modelcontextprotocol/sdk/server/streamableHttp'
      )
      const { createServer } = await import('node:http')

      const mcpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      })
      await this.connect(mcpTransport)

      const auth = this._auth
      const httpServer = createServer(async (req, res) => {
        if (req.url?.split('?')[0] === path) {
          if (auth) {
            const authHeader = req.headers.authorization
            const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

            if (!bearer) {
              res
                .writeHead(401, { 'Content-Type': 'application/json' })
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
              const status = err instanceof AuthorizationError ? 403 : 401
              res
                .writeHead(status, { 'Content-Type': 'application/json' })
                .end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Authentication failed',
                  }),
                )
              return
            }
          }

          await mcpTransport.handleRequest(req, res)
        } else {
          res.writeHead(404).end()
        }
      })

      this._httpServer = httpServer

      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, host, resolve)
      })

      const bound = httpServer.address() as AddressInfo
      this._address = { host: bound.address, port: bound.port, path }
    }
  }

  async close(): Promise<void> {
    if (this._httpServer) {
      await new Promise<void>((resolve, reject) => {
        this._httpServer!.close((err) => (err != null ? reject(err) : resolve()))
      })
      this._httpServer = null
    }
    this._address = null
    await this._server.close()
  }
}
