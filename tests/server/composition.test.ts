import { describe, it, expect, afterEach } from 'vitest'
import { FastMCP } from '../../src/server/FastMCP'
import { createProxy } from '../../src/server/proxy'
import { Client } from '@modelcontextprotocol/sdk/client/index'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types'
import { z } from 'zod'

async function makeClient(server: FastMCP): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

describe('Server — Composition', () => {
  const servers: FastMCP[] = []
  const clients: Client[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    for (const s of servers.splice(0)) await s.close().catch(() => {})
  })

  function track(server: FastMCP): FastMCP {
    servers.push(server)
    return server
  }

  async function trackedClient(server: FastMCP): Promise<Client> {
    const c = await makeClient(server)
    clients.push(c)
    return c
  }

  describe('mounting', () => {
    it("a mounted server's tools are accessible via the parent", async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.tool({ name: 'add', description: 'add numbers' }, () => 42)

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = await trackedClient(parent)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('add')
    })

    it("a mounted server's resources are accessible via the parent", async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.resource({ uri: 'memo://readme', name: 'readme' }, () => 'hello')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = await trackedClient(parent)
      const { resources } = await client.listResources()
      expect(resources.map((r) => r.uri)).toContain('memo://readme')
    })

    it("a mounted server's prompts are accessible via the parent", async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.prompt({ name: 'greet', description: 'greet' }, () => 'hello')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = await trackedClient(parent)
      const { prompts } = await client.listPrompts()
      expect(prompts.map((p) => p.name)).toContain('greet')
    })

    it('tools added to a child server after mounting immediately appear in the parent', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      child.tool({ name: 'late_tool', description: 'added late' }, () => 'ok')

      const client = await trackedClient(parent)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('late_tool')
    })

    it('resources added to a child server after mounting immediately appear in the parent', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      child.resource({ uri: 'memo://late', name: 'late' }, () => 'content')

      const client = await trackedClient(parent)
      const { resources } = await client.listResources()
      expect(resources.map((r) => r.uri)).toContain('memo://late')
    })

    it('prompts added to a child server after mounting immediately appear in the parent', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      child.prompt({ name: 'late_prompt', description: 'added late' }, () => 'hi')

      const client = await trackedClient(parent)
      const { prompts } = await client.listPrompts()
      expect(prompts.map((p) => p.name)).toContain('late_prompt')
    })

    it('list_changed notifications from a child server are forwarded to the parent clients', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = new Client({ name: 'test-client', version: '1.0.0' })
      clients.push(client)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await parent.connect(serverTransport)
      await client.connect(clientTransport)

      const notified = new Promise<void>((resolve) => {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => { resolve() })
      })

      child.tool({ name: 'new_tool', description: 'triggers notification' }, () => 'ok')

      await expect(notified).resolves.toBeUndefined()
    })

    it('mounting the same child twice is a no-op', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.tool({ name: 'tool_a', description: 'tool a' }, () => 'a')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)
      parent.mount(child) // second mount should be ignored

      const client = await trackedClient(parent)
      const { tools } = await client.listTools()
      expect(tools.filter((t) => t.name === 'tool_a')).toHaveLength(1)
    })

    it('mounting a server onto itself throws', () => {
      const server = track(new FastMCP({ name: 'server' }))
      expect(() => server.mount(server)).toThrow('Cannot mount a server onto itself')
    })

    it('mounting two children with the same tool name and no prefix throws a collision error', () => {
      const childA = track(new FastMCP({ name: 'a' }))
      childA.tool({ name: 'search', description: 'search' }, () => 'a')

      const childB = track(new FastMCP({ name: 'b' }))
      childB.tool({ name: 'search', description: 'search' }, () => 'b')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(childA)
      expect(() => parent.mount(childB)).toThrow('Tool name collision on mount: "search"')
    })

    it('mounting two children with the same resource URI and no prefix throws a collision error', () => {
      const childA = track(new FastMCP({ name: 'a' }))
      childA.resource({ uri: 'memo://data', name: 'data' }, () => 'a')

      const childB = track(new FastMCP({ name: 'b' }))
      childB.resource({ uri: 'memo://data', name: 'data' }, () => 'b')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(childA)
      expect(() => parent.mount(childB)).toThrow('Resource URI collision on mount: "memo://data"')
    })

    it('a tool added to a grandchild after all mounts are in place propagates to the grandparent', async () => {
      const grandchild = track(new FastMCP({ name: 'grandchild' }))
      const child = track(new FastMCP({ name: 'child' }))
      const parent = track(new FastMCP({ name: 'parent' }))

      child.mount(grandchild)
      parent.mount(child)

      grandchild.tool({ name: 'late_deep', description: 'added late to grandchild' }, () => 'deep')

      const client = await trackedClient(parent)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('late_deep')

      const result = await client.callTool({ name: 'late_deep', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: 'deep' }])
    })
  })

  describe('namespacing', () => {
    it('a prefix applied at mount time prevents name collisions across mounted servers', async () => {
      const childA = track(new FastMCP({ name: 'a' }))
      childA.tool({ name: 'search', description: 'search in A' }, () => 'a')

      const childB = track(new FastMCP({ name: 'b' }))
      childB.tool({ name: 'search', description: 'search in B' }, () => 'b')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(childA, 'a')
      parent.mount(childB, 'b')

      const client = await trackedClient(parent)
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('a_search')
      expect(names).toContain('b_search')
      expect(names).not.toContain('search')
    })

    it('a prefixed tool call is correctly routed to the child server handler', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.tool(
        { name: 'greet', description: 'greet', input: z.object({ name: z.string() }) },
        ({ name }) => `hello ${name}`,
      )

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child, 'v1')

      const client = await trackedClient(parent)
      const result = await client.callTool({ name: 'v1_greet', arguments: { name: 'world' } })
      expect(result.content).toEqual([{ type: 'text', text: 'hello world' }])
    })

    it('a prefix is applied to resource names, prompt names, and resource URIs', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.resource({ uri: 'memo://readme', name: 'readme' }, () => 'hello')
      child.prompt({ name: 'greet', description: 'greet' }, () => 'hi')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child, 'v1')

      const client = await trackedClient(parent)

      const { resources } = await client.listResources()
      const resource = resources.find((r) => r.uri === 'memo://v1/readme')
      expect(resource).toBeDefined()
      expect(resource?.name).toBe('v1_readme')

      const { prompts } = await client.listPrompts()
      expect(prompts.map((p) => p.name)).toContain('v1_greet')
    })

    it('resources on a namespaced child are readable via their prefixed URI', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.resource({ uri: 'memo://readme', name: 'readme' }, () => 'hello from readme')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child, 'v1')

      const client = await trackedClient(parent)
      const result = await client.readResource({ uri: 'memo://v1/readme' })
      expect(result.contents[0]).toMatchObject({ text: 'hello from readme' })
    })
  })

  describe('middleware chain delegation', () => {
    it('child onCallTool middleware runs when a mounted tool is called via the parent', async () => {
      let childCalls = 0
      const child = track(
        new FastMCP({
          name: 'child',
          middleware: [{ onCallTool: (_ctx, next) => { childCalls++; return next() } }],
        }),
      )
      child.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = await trackedClient(parent)
      await client.callTool({ name: 'ping', arguments: {} })
      expect(childCalls).toBe(1)
    })

    it('parent and child onCallTool middleware both run, parent first', async () => {
      const order: string[] = []
      const child = track(
        new FastMCP({
          name: 'child',
          middleware: [{ onCallTool: (_ctx, next) => { order.push('child'); return next() } }],
        }),
      )
      child.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      const parent = track(
        new FastMCP({
          name: 'parent',
          middleware: [{ onCallTool: (_ctx, next) => { order.push('parent'); return next() } }],
        }),
      )
      parent.mount(child)

      const client = await trackedClient(parent)
      await client.callTool({ name: 'ping', arguments: {} })
      expect(order).toEqual(['parent', 'child'])
    })

    it('child onCallTool middleware can short-circuit a call before the handler runs', async () => {
      let handlerRan = false
      const child = track(
        new FastMCP({
          name: 'child',
          middleware: [{
            onCallTool: async (_ctx, _next) => ({
              content: [{ type: 'text' as const, text: 'blocked' }],
              isError: true,
            }),
          }],
        }),
      )
      child.tool({ name: 'blocked', description: 'blocked' }, () => { handlerRan = true; return 'ok' })

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = await trackedClient(parent)
      const result = await client.callTool({ name: 'blocked', arguments: {} })
      expect(result.isError).toBe(true)
      expect(handlerRan).toBe(false)
    })

    it('child onReadResource middleware runs when a mounted resource is read via the parent', async () => {
      let childCalls = 0
      const child = track(
        new FastMCP({
          name: 'child',
          middleware: [{ onReadResource: (_ctx, next) => { childCalls++; return next() } }],
        }),
      )
      child.resource({ uri: 'memo://data', name: 'data' }, () => 'hello')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = await trackedClient(parent)
      await client.readResource({ uri: 'memo://data' })
      expect(childCalls).toBe(1)
    })

    it('child onGetPrompt middleware runs when a mounted prompt is rendered via the parent', async () => {
      let childCalls = 0
      const child = track(
        new FastMCP({
          name: 'child',
          middleware: [{ onGetPrompt: (_ctx, next) => { childCalls++; return next() } }],
        }),
      )
      child.prompt({ name: 'greet', description: 'greet' }, () => 'hello')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = await trackedClient(parent)
      await client.getPrompt({ name: 'greet' })
      expect(childCalls).toBe(1)
    })

    it('middleware at every level of a three-deep nested mount all run for a single call', async () => {
      const ran = { grandchild: false, child: false, parent: false }

      const grandchild = track(
        new FastMCP({
          name: 'gc',
          middleware: [{ onCallTool: (_ctx, next) => { ran.grandchild = true; return next() } }],
        }),
      )
      grandchild.tool({ name: 'deep', description: 'deep' }, () => 'deep')

      const child = track(
        new FastMCP({
          name: 'child',
          middleware: [{ onCallTool: (_ctx, next) => { ran.child = true; return next() } }],
        }),
      )
      child.mount(grandchild)

      const parent = track(
        new FastMCP({
          name: 'parent',
          middleware: [{ onCallTool: (_ctx, next) => { ran.parent = true; return next() } }],
        }),
      )
      parent.mount(child)

      const client = await trackedClient(parent)
      await client.callTool({ name: 'deep', arguments: {} })
      expect(ran).toEqual({ grandchild: true, child: true, parent: true })
    })

    it('ctx.log() called inside a mounted child handler reaches the parent client', async () => {
      const { LoggingMessageNotificationSchema } = await import('@modelcontextprotocol/sdk/types')

      const child = track(new FastMCP({ name: 'child' }))
      child.tool({ name: 'logger', description: 'logs' }, async () => {
        await child.getContext().info('hello from child')
        return 'done'
      })

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child)

      const client = new Client({ name: 'test-client', version: '1.0.0' })
      clients.push(client)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await parent.connect(serverTransport)
      await client.connect(clientTransport)

      const received: string[] = []
      client.setNotificationHandler(LoggingMessageNotificationSchema, (notif) => {
        received.push(notif.params.data as string)
      })

      await client.callTool({ name: 'logger', arguments: {} })
      expect(received).toContain('hello from child')
    })
  })

  describe('proxying', () => {
    it('a remote HTTP server can be wrapped as a proxy and mounted', async () => {
      const remote = track(new FastMCP({ name: 'remote' }))
      remote.tool({ name: 'ping', description: 'ping' }, () => 'pong')
      await remote.run({ transport: 'http', port: 0 })

      const port = remote.address!.port
      const proxy = track(await createProxy({ type: 'http', url: `http://127.0.0.1:${port}/mcp` }))

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(proxy)

      const client = await trackedClient(parent)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('ping')
    })

    it('a subprocess stdio server can be wrapped as a proxy and mounted', async () => {
      const { fileURLToPath } = await import('url')
      const { join, dirname } = await import('path')
      const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../helpers/stdio-server.mjs')

      const proxy = track(await createProxy({ type: 'stdio', command: 'node', args: [fixturePath] }))
      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(proxy)

      const client = await trackedClient(parent)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('greet')

      const result = await client.callTool({ name: 'greet', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: 'hello from stdio' }])
    })

    it('tools on the proxied server are callable via the parent', async () => {
      const remote = track(new FastMCP({ name: 'remote' }))
      remote.tool(
        { name: 'echo', description: 'echo', input: z.object({ message: z.string() }) },
        ({ message }) => message,
      )
      await remote.run({ transport: 'http', port: 0 })

      const port = remote.address!.port
      const proxy = track(await createProxy({ type: 'http', url: `http://127.0.0.1:${port}/mcp` }))

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(proxy)

      const client = await trackedClient(parent)
      const result = await client.callTool({ name: 'echo', arguments: { message: 'hello' } })
      expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('resources on a proxied server are readable via the parent', async () => {
      const remote = track(new FastMCP({ name: 'remote' }))
      remote.resource({ uri: 'memo://note', name: 'note' }, () => 'proxied content')
      await remote.run({ transport: 'http', port: 0 })

      const port = remote.address!.port
      const proxy = track(await createProxy({ type: 'http', url: `http://127.0.0.1:${port}/mcp` }))

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(proxy)

      const client = await trackedClient(parent)
      const result = await client.readResource({ uri: 'memo://note' })
      expect(result.contents[0]).toMatchObject({ text: 'proxied content' })
    })

    it('prompts on a proxied server are renderable via the parent', async () => {
      const remote = track(new FastMCP({ name: 'remote' }))
      remote.prompt({ name: 'hello', description: 'hello prompt' }, () => 'hello from remote')
      await remote.run({ transport: 'http', port: 0 })

      const port = remote.address!.port
      const proxy = track(await createProxy({ type: 'http', url: `http://127.0.0.1:${port}/mcp` }))

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(proxy)

      const client = await trackedClient(parent)
      const result = await client.getPrompt({ name: 'hello' })
      expect(result.messages[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'hello from remote' } })
    })

    it('template resources on a proxied server are listed and readable via the parent', async () => {
      const remote = track(new FastMCP({ name: 'remote' }))
      remote.resource(
        { uri: 'memo://notes/{id}', name: 'note' },
        (params) => `note ${(params as { id: string }).id}`,
      )
      await remote.run({ transport: 'http', port: 0 })

      const port = remote.address!.port
      const proxy = track(await createProxy({ type: 'http', url: `http://127.0.0.1:${port}/mcp` }))

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(proxy)

      const client = await trackedClient(parent)
      const { resourceTemplates } = await client.listResourceTemplates()
      expect(resourceTemplates.map((r) => r.uriTemplate)).toContain('memo://notes/{id}')

      const result = await client.readResource({ uri: 'memo://notes/42' })
      expect(result.contents[0]).toMatchObject({ text: 'note 42' })
    })

    it('tools added to the remote after proxy creation are not immediately visible (snapshot is point-in-time)', async () => {
      const remote = track(new FastMCP({ name: 'remote' }))
      remote.tool({ name: 'original', description: 'original' }, () => 'ok')
      await remote.run({ transport: 'http', port: 0 })

      const port = remote.address!.port
      // cacheTtl: 0 disables TTL-based lazy resync so we can observe the snapshot before any resync
      const proxy = track(await createProxy({ type: 'http', url: `http://127.0.0.1:${port}/mcp`, cacheTtl: 0 }))

      // Verify initial snapshot contains what was there at creation time
      const proxyClient = await trackedClient(proxy)
      const { tools: initial } = await proxyClient.listTools()
      expect(initial.map((t) => t.name)).toContain('original')

      // Add a tool to remote AFTER proxy was created and synced
      remote.tool({ name: 'added_later', description: 'added after sync' }, () => 'late')

      // Without waiting for any async notification round-trip, proxy still shows the old snapshot
      const { tools: snapshot } = await proxyClient.listTools()
      expect(snapshot.map((t) => t.name)).not.toContain('added_later')
    })

    it('closing the parent closes owned proxy connections', async () => {
      const remote = track(new FastMCP({ name: 'remote' }))
      remote.tool({ name: 'ping', description: 'ping' }, () => 'pong')
      await remote.run({ transport: 'http', port: 0 })

      const port = remote.address!.port
      const proxy = track(await createProxy({ type: 'http', url: `http://127.0.0.1:${port}/mcp` }))

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(proxy)

      // Verify it works before close
      const clientBefore = await trackedClient(parent)
      const before = await clientBefore.callTool({ name: 'ping', arguments: {} })
      expect(before.content).toEqual([{ type: 'text', text: 'pong' }])

      await parent.close()

      // After parent closes, the proxy's underlying SDK client is closed.
      // Connecting a fresh client directly to the proxy and calling the tool returns isError.
      const clientAfter = new Client({ name: 'test', version: '1.0.0' })
      clients.push(clientAfter)
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await proxy.connect(st)
      await clientAfter.connect(ct)

      const result = await clientAfter.callTool({ name: 'ping', arguments: {} })
      expect(result.isError).toBe(true)
    })
  })
})
