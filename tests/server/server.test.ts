import { describe, it, expect, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client } from '@modelcontextprotocol/client'
import { FastMCP } from 'fastmcp-ts/server'
import { contextStore } from '../../src/server/context.js'
import { createTestClient } from '../helpers/createTestClient.js'
import { LEGACY_INITIALIZE_PROTOCOL_VERSION } from '../helpers/http.js'

describe('Server', () => {
  describe('instantiation', () => {
    it('creates a server with a name', () => {
      const mcp = new FastMCP({ name: 'test-server' })
      expect(mcp.name).toBe('test-server')
    })
    it.todo('accepts server-level configuration (strict validation, error masking, etc.)')
  })

  describe('in-process connection', () => {
    let close: () => Promise<void>

    afterEach(async () => { await close?.() })

    it('accepts an in-process client connection', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      ;({ close } = await createTestClient(mcp))
    })
  })

  describe('transports', () => {
    let close: () => Promise<void>

    afterEach(async () => { await close?.() })

    it('runs over stdio', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      const stdin = new PassThrough()
      const stdout = new PassThrough()

      const responsePromise = new Promise<string>((resolve) => {
        stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      })

      await mcp.run({ transport: 'stdio', stdin, stdout })
      close = () => mcp.close()

      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LEGACY_INITIALIZE_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.0' },
          },
        }) + '\n',
      )

      const msg = JSON.parse(await responsePromise)
      expect(msg.result.serverInfo.name).toBe('test-server')
    })

    it('runs over stdio with a modern (2026-07-28) opening exchange', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')
      const stdin = new PassThrough()
      const stdout = new PassThrough()

      const responsePromise = new Promise<string>((resolve) => {
        stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      })

      await mcp.run({ transport: 'stdio', stdin, stdout })
      close = () => mcp.close()

      // A modern client's opening exchange: server/discover carrying the per-request
      // _meta envelope (rather than the 2025 initialize handshake). serveStdio pins
      // the connection's era from this first message.
      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }) + '\n',
      )

      const msg = JSON.parse(await responsePromise)
      expect(msg.result.supportedVersions).toContain('2026-07-28')
      expect(msg.result.capabilities.tools).toBeDefined()
    })

    it('stdio-legacy initialize advertises resources.subscribe (the legacy RPC path is live)', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      const stdin = new PassThrough()
      const stdout = new PassThrough()

      const responsePromise = new Promise<string>((resolve) => {
        stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      })

      await mcp.run({ transport: 'stdio', stdin, stdout })
      close = () => mcp.close()

      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LEGACY_INITIALIZE_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.0' },
          },
        }) + '\n',
      )

      const msg = JSON.parse(await responsePromise)
      expect(msg.result.capabilities.resources.subscribe).toBe(true)
    })

    it('stdio-modern discover does NOT advertise resources.subscribe (the legacy-only RPCs do not exist on this era)', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      const stdin = new PassThrough()
      const stdout = new PassThrough()

      const responsePromise = new Promise<string>((resolve) => {
        stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      })

      await mcp.run({ transport: 'stdio', stdin, stdout })
      close = () => mcp.close()

      // Same modern opening exchange as the test above — server/discover pins the
      // connection's era to modern from this first message.
      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }) + '\n',
      )

      const msg = JSON.parse(await responsePromise)
      // Mirrors the modern HTTP path (_getModernHandler): `resources.subscribe` is
      // omitted entirely, matching the modern `server/discover` document's pinned
      // `resources: { listChanged: true }` shape — no legacy-only surface leaks in.
      expect(msg.result.capabilities.resources.subscribe).toBeUndefined()
      expect(msg.result.capabilities.resources.listChanged).toBe(true)
    })

    it('runs over HTTP (Streamable HTTP)', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!
      const client = new Client(
        { name: 'test-client', version: '0.0.0' },
        { capabilities: {} },
      )
      const clientTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      )
      await client.connect(clientTransport)
      await client.close()
    })
  })

  describe('env overrides', () => {
    let close: () => Promise<void>
    const originalMcpHost = process.env.MCP_HOST

    afterEach(async () => {
      await close?.()
      if (originalMcpHost === undefined) delete process.env.MCP_HOST
      else process.env.MCP_HOST = originalMcpHost
    })

    it('MCP_HOST overrides the default bind host when run() is not given an explicit host', async () => {
      process.env.MCP_HOST = '0.0.0.0'
      const mcp = new FastMCP({ name: 'mcp-host-env-test' })
      await mcp.run({ transport: 'http', port: 0 })
      close = () => mcp.close()

      expect(mcp.address!.host).toBe('0.0.0.0')
    })

    it('an explicit run() host option still wins over MCP_HOST', async () => {
      process.env.MCP_HOST = '0.0.0.0'
      const mcp = new FastMCP({ name: 'mcp-host-env-precedence-test' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      expect(mcp.address!.host).toBe('127.0.0.1')
    })
  })

  describe('dual-era HTTP dispatch', () => {
    let close: () => Promise<void>

    afterEach(async () => { await close?.() })

    it('a modern (2026-07-28) client can call a tool over the same endpoint', async () => {
      const mcp = new FastMCP({ name: 'dual-era-test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!
      const client = new Client(
        { name: 'modern-client', version: '0.0.0' },
        { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      const clientTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      )
      await client.connect(clientTransport)
      expect(client.getProtocolEra()).toBe('modern')

      const result = await client.callTool({ name: 'ping', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: 'pong' }])

      await client.close()
    })

    it('ctx.log() inside a handler does not error or hang a modern request without a logLevel', async () => {
      // Modern (2026-07-28) requests gate ctx.log on the per-request `_meta` logLevel
      // envelope key: absent means suppressed, not unfiltered (delegated entirely to
      // the SDK's own sdkCtx.mcpReq.log — see context.ts). This confirms the tool call
      // still completes normally when the client (as today, before W7's client-side
      // logLevel opt-in) sends no logLevel at all.
      const mcp = new FastMCP({ name: 'dual-era-test' })
      mcp.tool({ name: 'noisy', description: 'logs then returns' }, async () => {
        const ctx = mcp.getContext()
        await ctx.info('this should be silently suppressed on modern era, not throw')
        return 'done'
      })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!
      const client = new Client(
        { name: 'modern-client', version: '0.0.0' },
        { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))

      const result = await client.callTool({ name: 'noisy', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: 'done' }])

      await client.close()
    })

    it('a legacy (2025-era) client keeps working on the same endpoint the modern client used', async () => {
      const mcp = new FastMCP({ name: 'dual-era-test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!
      const url = new URL(`http://127.0.0.1:${port}/mcp`)

      // A modern client hits the endpoint first (exercises the modern branch)...
      const modernClient = new Client(
        { name: 'modern-client', version: '0.0.0' },
        { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      await modernClient.connect(new StreamableHTTPClientTransport(url))
      expect(modernClient.getProtocolEra()).toBe('modern')
      await modernClient.close()

      // ...and a default (legacy) client still works against the very same server.
      const legacyClient = new Client({ name: 'legacy-client', version: '0.0.0' }, { capabilities: {} })
      await legacyClient.connect(new StreamableHTTPClientTransport(url))
      const result = await legacyClient.callTool({ name: 'ping', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: 'pong' }])
      await legacyClient.close()
    })

    it('cacheHints configure ttlMs/cacheScope on modern (2026-07-28) cacheable results', async () => {
      const mcp = new FastMCP({
        name: 'cache-hints-test',
        cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } },
      })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!

      // ttlMs/cacheScope are wire-only fields the SDK client strips from its public
      // result types, so this is verified with a raw request carrying the modern
      // per-request envelope rather than through the Client wrapper.
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      const body = await res.json()
      expect(body.result.ttlMs).toBe(60_000)
      expect(body.result.cacheScope).toBe('public')
    })
  })

  describe('CORS', () => {
    let close: () => Promise<void>

    afterEach(async () => { await close?.() })

    it('responds to OPTIONS preflight with CORS headers and 204', async () => {
      const mcp = new FastMCP({ name: 'cors-test' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
      expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/i)
    })

    it('regular responses include Access-Control-Allow-Origin', async () => {
      const mcp = new FastMCP({ name: 'cors-test' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_INITIALIZE_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
      })
      expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
    })
  })

  describe('auth — clientId round-trip', () => {
    let close: () => Promise<void>

    afterEach(async () => { await close?.() })

    it('clientId is undefined in ctx.auth when the verifier does not return one', async () => {
      let capturedClientId: string | undefined = 'NOT_SET'

      const mcp = new FastMCP({
        name: 'auth-test',
        auth: {
          verify(token: string) {
            if (token !== 'valid') throw new Error('bad token')
            // Deliberately omit clientId
            return Promise.resolve({ token, scopes: [], claims: {} })
          },
        },
      })
      mcp.tool({ name: 'whoami', description: 'whoami' }, () => {
        capturedClientId = contextStore.getStore()?.auth?.clientId
        return 'ok'
      })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!
      const client = new Client({ name: 'test', version: '1' }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { requestInit: { headers: { Authorization: 'Bearer valid' } } },
      )
      await client.connect(transport)
      await client.callTool({ name: 'whoami', arguments: {} })
      await client.close()

      // toAccessToken converts '' → undefined via `|| undefined`; tool sees undefined
      expect(capturedClientId).toBeUndefined()
    })
  })
})
