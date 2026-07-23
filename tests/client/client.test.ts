import { describe, it, expect, afterEach } from 'vitest'
import { z } from 'zod/v4'
import { FastMCP } from 'fastmcp-ts/server'
import { Client } from 'fastmcp-ts/client'
import { Server, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

function makeServer(name = 'test') {
  const mcp = new FastMCP({ name, version: '1.0.0' })
  mcp.tool({ name: 'echo', description: 'a tool', input: z.object({ msg: z.string() }) }, ({ msg }) => msg)
  return mcp
}

describe('Client', () => {
  describe('lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const client = new Client(makeServer())
      expect(client.isConnected()).toBe(false)
    })

    it('isConnected() returns true after connect', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      expect(client.isConnected()).toBe(true)
    })

    it('isConnected() returns false after close()', async () => {
      const client = await Client.connect(makeServer())
      await client.close()
      expect(client.isConnected()).toBe(false)
    })

    it('close() is idempotent when called multiple times', async () => {
      const client = await Client.connect(makeServer())
      await client.close()
      await expect(client.close()).resolves.toBeUndefined()
      expect(client.isConnected()).toBe(false)
    })

    it('reentrant connect() ref-counts — requires matching closes', async () => {
      const client = new Client(makeServer())
      await client.connect()
      await client.connect()
      expect(client.isConnected()).toBe(true)
      await client.close() // refCount → 1
      expect(client.isConnected()).toBe(true)
      await client.close() // refCount → 0, actually closes
      expect(client.isConnected()).toBe(false)
    })

    it('ping() resolves when connected', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      await expect(client.ping()).resolves.toBe(true)
    })

    it('throws when calling methods without connecting', async () => {
      const client = new Client(makeServer())
      await expect(client.listTools()).rejects.toThrow('not connected')
    })

    it('static Client.connect() returns a ready-to-use client', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      expect(client.isConnected()).toBe(true)
      const tools = await client.listTools()
      expect(tools).toBeInstanceOf(Array)
    })

    it('supports `await using` for automatic cleanup', async () => {
      let connectedDuringBlock = false
      {
        await using client = await Client.connect(makeServer())
        connectedDuringBlock = client.isConnected()
      }
      expect(connectedDuringBlock).toBe(true)
    })
  })

  describe('autoInitialize', () => {
    it('auto-initializes on connect by default', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      await expect(client.listTools()).resolves.toBeInstanceOf(Array)
    })

    it.todo('skips MCP handshake when autoInitialize is false')
  })

  describe('in-process transport', () => {
    it('connects directly to a FastMCP server instance', async () => {
      const mcp = new FastMCP({ name: 'direct', version: '1.0.0' })
      mcp.tool({ name: 'greet', description: 'a tool', input: z.object({ name: z.string() }) }, ({ name }) => `hello ${name}`)

      const client = await Client.connect(mcp)
      await using _ = client

      const result = await client.callTool('greet', { name: 'world' })
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello world' })
    })

    it('getProtocolEra() is "legacy" for the default in-process (InMemoryTransport) connection', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      expect(client.getProtocolEra()).toBe('legacy')
    })

    it('pinning modern era routes through the server\'s _modernFetch instead of InMemoryTransport', async () => {
      const mcp = makeServer()
      const client = await Client.connect(mcp, {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      })
      await using _ = client
      expect(client.getProtocolEra()).toBe('modern')
      const tools = await client.listTools()
      expect(tools.some((t) => t.name === 'echo')).toBe(true)
    })
  })

  describe('era-aware ping()', () => {
    it('legacy era: resolves true via the ping RPC', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      expect(client.getProtocolEra()).toBe('legacy')
      await expect(client.ping()).resolves.toBe(true)
    })

    it('modern era (pinned, in-process): resolves true via server/discover instead of ping', async () => {
      const client = await Client.connect(makeServer(), {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      })
      await using _ = client
      expect(client.getProtocolEra()).toBe('modern')
      await expect(client.ping()).resolves.toBe(true)
    })
  })

  describe('era-aware setLogLevel()', () => {
    it('legacy era: resolves (sends the logging/setLevel RPC)', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      await expect(client.setLogLevel('info')).resolves.toBeUndefined()
    })

    it('modern era: resolves without error and does not break subsequent calls (no logging/setLevel RPC exists)', async () => {
      const client = await Client.connect(makeServer(), {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      })
      await using _ = client
      await expect(client.setLogLevel('debug')).resolves.toBeUndefined()
      // Subsequent requests must still work — the level is threaded into _meta
      // rather than sent as a (nonexistent, on modern era) RPC.
      const tools = await client.listTools()
      expect(tools.some((t) => t.name === 'echo')).toBe(true)
    })
  })

  describe('inputRequired passthrough', () => {
    it('accepts inputRequired options without throwing', async () => {
      const client = await Client.connect(makeServer(), {
        inputRequired: { autoFulfill: false, maxRounds: 3 },
      })
      await using _ = client
      expect(client.isConnected()).toBe(true)
    })
  })

  describe('response cache passthrough', () => {
    it('accepts responseCacheStore/cachePartition/defaultCacheTtlMs without throwing', async () => {
      const client = await Client.connect(makeServer(), {
        cachePartition: 'principal-a',
        defaultCacheTtlMs: 1000,
      })
      await using _ = client
      expect(client.isConnected()).toBe(true)
      const tools = await client.listTools()
      expect(tools.some((t) => t.name === 'echo')).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// setLogLevel() on modern era: verify the level actually reaches the server's
// _meta, not just that calls don't throw. Built directly on createMcpHandler
// (real HTTP, not in-process) since we need to inspect the raw incoming
// request's _meta — FastMCP's own McpContext doesn't expose it.
// ---------------------------------------------------------------------------

describe('Client — setLogLevel() modern-era _meta threading', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  it('threads the level into _meta[io.modelcontextprotocol/logLevel] on subsequent requests', async () => {
    // The server lifts the per-request _meta envelope off `params` before the
    // handler runs and surfaces it at `ctx.mcpReq.envelope` instead — the
    // registered handler's `request.params._meta` is not where it lands.
    const receivedEnvelopes: Array<Record<string, unknown> | undefined> = []

    const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/call', async (_request, ctx) => {
      receivedEnvelopes.push(
        (ctx as { mcpReq?: { envelope?: Record<string, unknown> } })?.mcpReq?.envelope,
      )
      return { content: [{ type: 'text', text: 'ok' }] }
    })
    server.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'noop', description: 'x', inputSchema: { type: 'object' } }],
    }))

    const handler = createMcpHandler(() => server, { legacy: 'reject' })
    const nodeHandler = toNodeHandler(handler)
    const httpServer = createServer((req, res) => { void nodeHandler(req, res) })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as AddressInfo).port

    const client = await Client.connect(`http://127.0.0.1:${port}/mcp`, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    cleanup = async () => {
      await client.close()
      await handler.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }

    expect(client.getProtocolEra()).toBe('modern')

    // Before setLogLevel: no log-level meta key.
    await client.callTool('noop', {})
    expect(receivedEnvelopes[0]?.['io.modelcontextprotocol/logLevel']).toBeUndefined()

    // After setLogLevel: the key rides along on the next request.
    await client.setLogLevel('debug')
    await client.callTool('noop', {})
    expect(receivedEnvelopes[1]?.['io.modelcontextprotocol/logLevel']).toBe('debug')
  })
})
