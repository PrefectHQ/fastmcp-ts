import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod/v4'
import { FastMCP } from 'fastmcp-ts/server'
import { Client, MultiServerClient } from 'fastmcp-ts/client'
import type { TextResourceContents } from "@modelcontextprotocol/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServerA() {
  const mcp = new FastMCP({ name: 'serverA', version: '1.0.0' })
  mcp.tool({ name: 'ping', description: 'ping from A', input: z.object({}) }, () => 'pong-a')
  mcp.tool(
    { name: 'echo', description: 'echo from A', input: z.object({ msg: z.string() }) },
    ({ msg }) => msg,
  )
  mcp.resource({ uri: 'a://data', name: 'a-data', description: 'data from A' }, () => 'data-a')
  mcp.prompt({ name: 'greet', description: 'greet from A', arguments: [] }, () => 'hello from A')
  return mcp
}

function makeServerB() {
  const mcp = new FastMCP({ name: 'serverB', version: '1.0.0' })
  mcp.tool({ name: 'ping', description: 'ping from B', input: z.object({}) }, () => 'pong-b')
  mcp.tool(
    { name: 'search', description: 'search in B', input: z.object({ q: z.string() }) },
    ({ q }) => `results for ${q}`,
  )
  mcp.resource({ uri: 'b://data', name: 'b-data', description: 'data from B' }, () => 'data-b')
  mcp.resource(
    { uri: 'b://item/{id}', name: 'b-item', description: 'item template' },
    (params) => `item-${params?.id}`,
  )
  mcp.prompt({ name: 'greet', description: 'greet from B', arguments: [] }, () => 'hello from B')
  return mcp
}

// ---------------------------------------------------------------------------
// McpConfig
// ---------------------------------------------------------------------------

describe('Client — Multi-server', () => {
  describe('McpConfig — lifecycle', () => {
    it('accepts a McpConfig with multiple server entries and returns a MultiServerClient', async () => {
      const a = makeServerA()
      const b = makeServerB()
      const client = await Client.connect({ mcpServers: { a, b } })
      await using _ = client
      expect(client).toBeInstanceOf(MultiServerClient)
    })

    it('Client.connect() with single-entry McpConfig still returns a Client', async () => {
      const a = makeServerA()
      const client = await Client.connect({ mcpServers: { a } })
      await using _ = client
      expect(client).toBeInstanceOf(Client)
      expect(client).not.toBeInstanceOf(MultiServerClient)
    })

    it('establishes connections to each configured server on connect()', async () => {
      const a = makeServerA()
      const b = makeServerB()
      const client = await MultiServerClient.connect({ mcpServers: { a, b } })
      await using _ = client
      expect(client.isConnected()).toBe(true)
    })

    it('isConnected() returns false before connect', () => {
      const a = makeServerA()
      const b = makeServerB()
      const client = new MultiServerClient({ mcpServers: { a, b } })
      expect(client.isConnected()).toBe(false)
    })

    it('isConnected() returns false after close()', async () => {
      const a = makeServerA()
      const b = makeServerB()
      const client = await MultiServerClient.connect({ mcpServers: { a, b } })
      await client.close()
      expect(client.isConnected()).toBe(false)
    })

    it('closes all server connections on close()', async () => {
      const a = makeServerA()
      const b = makeServerB()
      const client = await MultiServerClient.connect({ mcpServers: { a, b } })
      await client.close()
      expect(client.isConnected()).toBe(false)
      // Subsequent close is a no-op
      await expect(client.close()).resolves.toBeUndefined()
    })

    it('concurrent connect() calls only connect once', async () => {
      const a = makeServerA()
      const b = makeServerB()
      const client = new MultiServerClient({ mcpServers: { a, b } })
      await Promise.all([client.connect(), client.connect()])
      await using _ = client
      expect(client.isConnected()).toBe(true)
    })

    it('supports await using for automatic cleanup', async () => {
      const a = makeServerA()
      const b = makeServerB()
      let wasConnected = false
      {
        await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
        wasConnected = client.isConnected()
      }
      expect(wasConnected).toBe(true)
    })

    it('throws when mcpServers config is empty', async () => {
      const client = new MultiServerClient({ mcpServers: {} })
      await expect(client.connect()).rejects.toThrow('empty')
    })

    it('rolls back and throws when any server fails to connect', async () => {
      const a = makeServerA()
      // Bad entry — not an McpServerLike, url, or command
      const badEntry = { url: 'http://127.0.0.1:1' }
      const client = new MultiServerClient({
        mcpServers: { a: a as never, bad: badEntry as never },
      })
      await expect(client.connect()).rejects.toThrow()
      expect(client.isConnected()).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Namespacing — tools
  // -------------------------------------------------------------------------

  describe('namespacing — tools', () => {
    it('listTools() returns merged tool list with serverName_ prefix', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const tools = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual(
        expect.arrayContaining(['a_ping', 'a_echo', 'b_ping', 'b_search']),
      )
    })

    it('listTools() tools from each server are prefixed with the server name', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const tools = await client.listTools()
      const aTools = tools.filter((t) => t.name.startsWith('a_'))
      const bTools = tools.filter((t) => t.name.startsWith('b_'))
      expect(aTools.length).toBe(2)
      expect(bTools.length).toBe(2)
    })

    it('callTool() routes to the correct server based on namespace prefix', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const resultA = await client.callTool('a_ping')
      const resultB = await client.callTool('b_ping')
      const textA = resultA.content.find((c) => c.type === 'text')
      const textB = resultB.content.find((c) => c.type === 'text')
      expect((textA as { text: string }).text).toBe('pong-a')
      expect((textB as { text: string }).text).toBe('pong-b')
    })

    it('callTool() passes arguments to the correct server', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const result = await client.callTool('b_search', { q: 'hello' })
      const text = result.content.find((c) => c.type === 'text')
      expect((text as { text: string }).text).toBe('results for hello')
    })

    it('callTool() throws ToolCallError on server-side error', async () => {
      const mcp = new FastMCP({ name: 'err', version: '1.0.0' })
      mcp.tool({ name: 'fail', description: 'fail', input: z.object({}) }, () => {
        throw new Error('intentional failure')
      })
      await using client = await MultiServerClient.connect({ mcpServers: { err: mcp } })
      // Single-entry config still creates a MultiServerClient via new constructor
      await expect(client.callTool('err_fail')).rejects.toThrow()
    })

    it('callTool() throws when tool name has no namespace prefix', async () => {
      const a = makeServerA()
      await using client = await MultiServerClient.connect({ mcpServers: { a } })
      await expect(client.callTool('ping')).rejects.toThrow('namespace prefix')
    })

    it('callTool() throws when the server name is unknown', async () => {
      const a = makeServerA()
      await using client = await MultiServerClient.connect({ mcpServers: { a } })
      await expect(client.callTool('unknown_ping')).rejects.toThrow('unknown')
    })

    it('callToolRaw() never throws on tool error', async () => {
      const mcp = new FastMCP({ name: 'err', version: '1.0.0' })
      mcp.tool({ name: 'fail', description: 'fail', input: z.object({}) }, () => {
        throw new Error('intentional failure')
      })
      await using client = await MultiServerClient.connect({ mcpServers: { err: mcp } })
      const result = await client.callToolRaw('err_fail')
      expect(result.isError).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Namespacing — resources
  // -------------------------------------------------------------------------

  describe('namespacing — resources', () => {
    it('listResources() returns merged list with resource names prefixed', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const resources = await client.listResources()
      const names = resources.map((r) => r.name).sort()
      expect(names).toEqual(expect.arrayContaining(['a_a-data', 'b_b-data']))
    })

    it('listResources() leaves URIs unchanged', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const resources = await client.listResources()
      const uris = resources.map((r) => r.uri).sort()
      expect(uris).toEqual(expect.arrayContaining(['a://data', 'b://data']))
    })

    it('listResourceTemplates() returns merged list with names prefixed, URIs unchanged', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const templates = await client.listResourceTemplates()
      expect(templates.some((t) => t.name === 'b_b-item')).toBe(true)
      expect(templates.some((t) => t.uriTemplate === 'b://item/{id}')).toBe(true)
    })

    it('readResource() routes to correct server after listResources() populates the map', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      await client.listResources()
      const contentsA = await client.readResource('a://data')
      const contentsB = await client.readResource('b://data')
      expect((contentsA[0] as TextResourceContents).text).toBe('data-a')
      expect((contentsB[0] as TextResourceContents).text).toBe('data-b')
    })

    it('readResource() falls back to try-all when URI map is not yet populated', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      // No listResources() call — map is empty
      const contents = await client.readResource('b://data')
      expect((contents[0] as TextResourceContents).text).toBe('data-b')
    })

    it('readResource() throws when URI is not found on any server', async () => {
      const a = makeServerA()
      await using client = await MultiServerClient.connect({ mcpServers: { a } })
      await expect(client.readResource('z://does-not-exist')).rejects.toThrow(
        'Resource not found',
      )
    })
  })

  // -------------------------------------------------------------------------
  // Namespacing — prompts
  // -------------------------------------------------------------------------

  describe('namespacing — prompts', () => {
    it('listPrompts() returns merged list with serverName_ prefix', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const prompts = await client.listPrompts()
      const names = prompts.map((p) => p.name).sort()
      expect(names).toEqual(expect.arrayContaining(['a_greet', 'b_greet']))
    })

    it('getPrompt() routes to the correct server based on namespace prefix', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const resultA = await client.getPrompt('a_greet')
      const resultB = await client.getPrompt('b_greet')
      const textA = resultA.messages[0]?.content
      const textB = resultB.messages[0]?.content
      expect((textA as { text: string }).text).toBe('hello from A')
      expect((textB as { text: string }).text).toBe('hello from B')
    })

    it('getPrompt() throws when server name is unknown', async () => {
      const a = makeServerA()
      await using client = await MultiServerClient.connect({ mcpServers: { a } })
      await expect(client.getPrompt('unknown_greet')).rejects.toThrow('unknown')
    })
  })

  // -------------------------------------------------------------------------
  // Ping
  // -------------------------------------------------------------------------

  describe('ping', () => {
    it('ping() resolves true when all servers are reachable', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      await expect(client.ping()).resolves.toBe(true)
    })

    it('throws when calling methods before connect()', async () => {
      const a = makeServerA()
      const client = new MultiServerClient({ mcpServers: { a } })
      await expect(client.listTools()).rejects.toThrow('not connected')
    })
  })

  // -------------------------------------------------------------------------
  // versionNegotiation (applied identically to every server) + era-aware
  // ping()/setLogLevel() fan-out
  // -------------------------------------------------------------------------

  describe('versionNegotiation', () => {
    it('with no versionNegotiation, every server negotiates legacy era', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      expect(client.getProtocolEra('a')).toBe('legacy')
      expect(client.getProtocolEra('b')).toBe('legacy')
    })

    it('pinning modern era applies identically to every in-process server', async () => {
      const a = makeServerA()
      const b = makeServerB()
      await using client = await MultiServerClient.connect(
        { mcpServers: { a, b } },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      expect(client.getProtocolEra('a')).toBe('modern')
      expect(client.getProtocolEra('b')).toBe('modern')
      const tools = await client.listTools()
      expect(tools.some((t) => t.name === 'a_echo')).toBe(true)
      expect(tools.some((t) => t.name === 'b_search')).toBe(true)
    })

    it('ping() uses server/discover instead of the ping RPC for modern-era sub-clients', async () => {
      const a = makeServerA()
      await using client = await MultiServerClient.connect(
        { mcpServers: { a } },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      await expect(client.ping()).resolves.toBe(true)
    })

    it('setLogLevel() resolves for modern-era sub-clients and does not break subsequent calls', async () => {
      const a = makeServerA()
      await using client = await MultiServerClient.connect(
        { mcpServers: { a } },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      await expect(client.setLogLevel('debug')).resolves.toBeUndefined()
      const tools = await client.listTools()
      expect(tools.some((t) => t.name === 'a_echo')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Per-server configuration
  // -------------------------------------------------------------------------

  describe('per-server configuration', () => {
    it('each server entry uses its own in-process transport', async () => {
      const a = makeServerA()
      const b = makeServerB()
      // Both are McpServerLike — each gets its own InMemoryTransport pair
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const tools = await client.listTools()
      expect(tools.length).toBe(4)
    })

    it('shared handlers.log fires for log messages from any server', async () => {
      const a = new FastMCP({ name: 'log-a', version: '1.0.0' })
      a.tool({ name: 'logit', description: 'log', input: z.object({}) }, () => {
        const ctx = a.getContext()
        ctx.info('from-a')
        return 'ok'
      })
      const b = new FastMCP({ name: 'log-b', version: '1.0.0' })
      b.tool({ name: 'logit', description: 'log', input: z.object({}) }, () => {
        const ctx = b.getContext()
        ctx.info('from-b')
        return 'ok'
      })

      const received: string[] = []
      await using client = await MultiServerClient.connect(
        { mcpServers: { a, b } },
        {
          handlers: {
            log: (msg) => {
              received.push(String(msg.data))
            },
          },
        },
      )

      await client.callTool('a_logit')
      await client.callTool('b_logit')
      expect(received).toContain('from-a')
      expect(received).toContain('from-b')
    })

    it('shared handlers.sampling works for sampling requests from any server', async () => {
      const a = new FastMCP({ name: 'sample-a', version: '1.0.0' })
      a.tool({ name: 'ask', description: 'ask', input: z.object({}) }, async () => {
        const ctx = a.getContext()
        const result = await ctx.sample({ messages: [], maxTokens: 10 })
        return (result as { content: { text: string } }).content.text
      })

      const samplingHandler = vi.fn().mockResolvedValue({
        role: 'assistant',
        content: { type: 'text', text: 'mocked-response' },
        model: 'test',
        stopReason: 'endTurn',
      })

      await using client = await MultiServerClient.connect(
        { mcpServers: { a } },
        { handlers: { sampling: samplingHandler } },
      )

      const result = await client.callTool('a_ask')
      const text = result.content.find((c) => c.type === 'text')
      expect((text as { text: string }).text).toBe('mocked-response')
      expect(samplingHandler).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // Collision edge case
  // -------------------------------------------------------------------------

  describe('namespacing — collision avoidance', () => {
    it('servers with the same local tool name are distinguished by prefix', async () => {
      const a = makeServerA() // has 'ping'
      const b = makeServerB() // also has 'ping'
      await using client = await MultiServerClient.connect({ mcpServers: { a, b } })
      const tools = await client.listTools()
      const pingTools = tools.filter((t) => t.name.includes('ping'))
      expect(pingTools.map((t) => t.name).sort()).toEqual(['a_ping', 'b_ping'])
    })

    it('server names containing underscores route callTool() correctly', async () => {
      // If the server is named "my_server", its tool "greet" appears as "my_server_greet".
      // indexOf('_') would split this as serverName="my", localName="server_greet" — wrong.
      // The fix (longest-prefix-first matching) must produce serverName="my_server".
      const my_server = new FastMCP({ name: 'my_server' })
      my_server.tool({ name: 'greet', description: 'greet', input: z.object({}) }, () => 'hello from my_server')
      await using client = await MultiServerClient.connect({ mcpServers: { my_server } })

      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('my_server_greet')

      const result = await client.callTool('my_server_greet')
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello from my_server' })
    })

    it('server named "a" and "a_b" both route correctly when "a_b" has a tool "c"', async () => {
      const a = new FastMCP({ name: 'a' })
      a.tool({ name: 'ping', description: 'ping', input: z.object({}) }, () => 'from-a')
      const a_b = new FastMCP({ name: 'a_b' })
      a_b.tool({ name: 'c', description: 'c', input: z.object({}) }, () => 'from-a_b')
      await using client = await MultiServerClient.connect({ mcpServers: { a, a_b } })

      const resultA = await client.callTool('a_ping')
      expect(resultA.content[0]).toMatchObject({ type: 'text', text: 'from-a' })

      const resultAB = await client.callTool('a_b_c')
      expect(resultAB.content[0]).toMatchObject({ type: 'text', text: 'from-a_b' })
    })
  })
})
