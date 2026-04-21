import { describe, it, expect, afterEach } from 'vitest'
import { FastMCP } from '../../src/server/FastMCP'
import { createProxy } from '../../src/server/proxy'
import { Client } from '@modelcontextprotocol/sdk/client/index'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types'

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
      child.tool({ name: 'greet', description: 'greet' }, ({ name }: { name: string }) => `hello ${name}`)

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child, 'v1')

      const client = await trackedClient(parent)
      const result = await client.callTool({ name: 'v1_greet', arguments: { name: 'world' } })
      expect(result.content).toEqual([{ type: 'text', text: 'hello world' }])
    })

    it('a prefix is applied to resource names and prompt names, not resource URIs', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.resource({ uri: 'memo://readme', name: 'readme' }, () => 'hello')
      child.prompt({ name: 'greet', description: 'greet' }, () => 'hi')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child, 'v1')

      const client = await trackedClient(parent)

      const { resources } = await client.listResources()
      const resource = resources.find((r) => r.uri === 'memo://readme')
      expect(resource).toBeDefined()
      expect(resource?.name).toBe('v1_readme')

      const { prompts } = await client.listPrompts()
      expect(prompts.map((p) => p.name)).toContain('v1_greet')
    })

    it('resources on a namespaced child are readable via their original URI', async () => {
      const child = track(new FastMCP({ name: 'child' }))
      child.resource({ uri: 'memo://readme', name: 'readme' }, () => 'hello from readme')

      const parent = track(new FastMCP({ name: 'parent' }))
      parent.mount(child, 'v1')

      const client = await trackedClient(parent)
      const result = await client.readResource({ uri: 'memo://readme' })
      expect(result.contents[0]).toMatchObject({ text: 'hello from readme' })
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

    it.todo('a subprocess server can be wrapped as a proxy and mounted')

    it('tools on the proxied server are callable via the parent', async () => {
      const remote = track(new FastMCP({ name: 'remote' }))
      remote.tool({ name: 'echo', description: 'echo' }, ({ message }: { message: string }) => message)
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
