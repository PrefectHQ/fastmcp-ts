import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FastMCP } from '../../src/server/FastMCP'
import { Client } from '@modelcontextprotocol/sdk/client/index'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import {
  renameTool,
  redescribeTool,
  FilterTransform,
  NamespaceTransform,
  ResourcesAsTools,
  PromptsAsTools,
  VersionFilter,
} from '../../src/server/transform'

async function makeClient(server: FastMCP): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

describe('Server — Transforms', () => {
  let server: FastMCP
  let client: Client

  afterEach(async () => {
    await server.close()
  })

  describe('renaming', () => {
    it('a tool can be renamed before it is delivered to the client', async () => {
      server = new FastMCP({ name: 'test', transforms: [renameTool('get_weather', 'weather')] })
      server.tool({ name: 'get_weather', description: 'Get weather' }, () => 'sunny')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('weather')
      expect(tools.map((t) => t.name)).not.toContain('get_weather')
    })

    it('a client request using the new name resolves to the original handler', async () => {
      server = new FastMCP({ name: 'test', transforms: [renameTool('get_weather', 'weather')] })
      server.tool({ name: 'get_weather', description: 'Get weather' }, () => 'sunny')
      client = await makeClient(server)

      const result = await client.callTool({ name: 'weather', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: 'sunny' }])
    })
  })

  describe('filtering', () => {
    it('a transform can hide specific tools from the list seen by clients', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [new FilterTransform({ tools: (v) => v.name !== 'internal_tool' })],
      })
      server.tool({ name: 'public_tool', description: 'Public' }, () => 'ok')
      server.tool({ name: 'internal_tool', description: 'Internal' }, () => 'secret')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('public_tool')
      expect(tools.map((t) => t.name)).not.toContain('internal_tool')
    })

    it('hidden tools remain callable internally', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [new FilterTransform({ tools: (v) => v.name !== 'internal_tool' })],
      })
      server.tool({ name: 'internal_tool', description: 'Internal' }, () => 'secret')
      client = await makeClient(server)

      const result = await client.callTool({ name: 'internal_tool', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: 'secret' }])
    })
  })

  describe('metadata modification', () => {
    it('a transform can rewrite a tool description before it is sent to the client', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [redescribeTool('get_weather', 'Fetch current weather conditions')],
      })
      server.tool({ name: 'get_weather', description: 'Get weather' }, () => 'sunny')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === 'get_weather')
      expect(tool?.description).toBe('Fetch current weather conditions')
    })
  })

  describe('type conversion', () => {
    it('a resource can be exposed as a tool via a transform', async () => {
      server = new FastMCP({ name: 'test', transforms: [new ResourcesAsTools()] })
      server.resource({ uri: 'docs://guide', name: 'Guide', mimeType: 'text/plain' }, () => 'hello')
      server.resource({ uri: 'docs://readme', name: 'Readme' }, () => 'world')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      const listTool = tools.find((t) => t.name === 'list_resources')
      expect(listTool).toBeDefined()

      const result = await client.callTool({ name: 'list_resources', arguments: {} })
      const listed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as unknown[]
      expect(listed).toHaveLength(2)
    })

    it('a prompt can be exposed as a tool via a transform', async () => {
      server = new FastMCP({ name: 'test', transforms: [new PromptsAsTools()] })
      server.prompt({ name: 'summarize', description: 'Summarize text' }, () => 'summary')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      const listTool = tools.find((t) => t.name === 'list_prompts')
      expect(listTool).toBeDefined()

      const result = await client.callTool({ name: 'list_prompts', arguments: {} })
      const listed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as unknown[]
      expect(listed).toHaveLength(1)
    })

    it('ResourcesAsTools combined with NamespaceTransform reports transformed URIs', async () => {
      server = new FastMCP({ name: 'test', transforms: [new NamespaceTransform('v1_'), new ResourcesAsTools()] })
      server.resource({ uri: 'data://items', name: 'Items' }, () => 'items')
      client = await makeClient(server)

      const result = await client.callTool({ name: 'v1_list_resources', arguments: {} })
      const listed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as Array<{ uri: string }>
      expect(listed[0].uri).toBe('v1_data://items')
    })

    it('ResourcesAsTools does not expose disabled resources', async () => {
      server = new FastMCP({ name: 'test', transforms: [new ResourcesAsTools()] })
      server.resource({ uri: 'public://items', name: 'Public' }, () => 'public')
      server.resource({ uri: 'private://items', name: 'Private', disabled: true }, () => 'private')
      client = await makeClient(server)

      const result = await client.callTool({ name: 'list_resources', arguments: {} })
      const listed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as Array<{ uri: string }>
      expect(listed).toHaveLength(1)
      expect(listed[0].uri).toBe('public://items')
    })

    it('PromptsAsTools combined with NamespaceTransform creates a namespaced list_prompts tool', async () => {
      server = new FastMCP({ name: 'test', transforms: [new NamespaceTransform('v1_'), new PromptsAsTools()] })
      server.prompt({ name: 'greet', description: 'Greet' }, () => 'hello')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('v1_list_prompts')
      expect(tools.map((t) => t.name)).not.toContain('list_prompts')
    })

    it('FilterTransform can hide a synthesized tool', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [
          new ResourcesAsTools(),
          new FilterTransform({ tools: (v) => v.name !== 'list_resources' }),
        ],
      })
      server.resource({ uri: 'data://items', name: 'Items' }, () => 'items')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).not.toContain('list_resources')
    })
  })

  describe('namespacing', () => {
    it('the namespace transform prefixes all component names with a given string', async () => {
      server = new FastMCP({ name: 'test', transforms: [new NamespaceTransform('v1_')] })
      server.tool({ name: 'search', description: 'Search' }, () => 'results')
      server.resource({ uri: 'data://items', name: 'Items' }, () => 'items')
      server.prompt({ name: 'greet', description: 'Greet' }, () => 'hello')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      expect(tools[0].name).toBe('v1_search')

      const { resources } = await client.listResources()
      expect(resources[0].name).toBe('v1_Items')
      expect(resources[0].uri).toBe('v1_data://items')

      const { prompts } = await client.listPrompts()
      expect(prompts[0].name).toBe('v1_greet')
    })

    it('a namespaced request is correctly routed back to the original component', async () => {
      server = new FastMCP({ name: 'test', transforms: [new NamespaceTransform('v1_')] })
      server.tool({ name: 'search', description: 'Search' }, () => 'found it')
      server.prompt({ name: 'greet', description: 'Greet' }, () => 'hello friend')
      client = await makeClient(server)

      const toolResult = await client.callTool({ name: 'v1_search', arguments: {} })
      expect(toolResult.content).toEqual([{ type: 'text', text: 'found it' }])

      const promptResult = await client.getPrompt({ name: 'v1_greet' })
      expect(promptResult.messages[0].content).toEqual({ type: 'text', text: 'hello friend' })
    })

    it('getPrompt resolves a transformed name even when a direct registration with that name also exists', async () => {
      server = new FastMCP({ name: 'test', transforms: [new NamespaceTransform('v1_')] })
      server.prompt({ name: 'greet', description: 'Greeting' }, () => 'from greet')
      server.prompt({ name: 'v1_greet', description: 'Direct' }, () => 'from v1_greet directly')
      client = await makeClient(server)

      const result = await client.getPrompt({ name: 'v1_greet' })
      expect(result.messages[0].content).toEqual({ type: 'text', text: 'from greet' })
    })
  })

  describe('version filtering', () => {
    beforeEach(() => {
      server = new FastMCP({ name: 'test', transforms: [new VersionFilter('v2')] })
      server.tool({ name: 'old_tool', description: 'Old', tags: ['v1'] }, () => 'old')
      server.tool({ name: 'new_tool', description: 'New', tags: ['v2'] }, () => 'new')
      server.tool({ name: 'both_tool', description: 'Both', tags: ['v1', 'v2'] }, () => 'both')
    })

    it('version filter exposes only components whose tags match the configured version range', async () => {
      client = await makeClient(server)
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('new_tool')
      expect(names).toContain('both_tool')
      expect(names).not.toContain('old_tool')
    })

    it('components without a version tag are excluded when a version filter is active', async () => {
      server.tool({ name: 'untagged_tool', description: 'No tags' }, () => 'untagged')
      client = await makeClient(server)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).not.toContain('untagged_tool')
    })

    it('multiple servers can be mounted with different version filters to serve versioned APIs from one instance', async () => {
      const v1Server = new FastMCP({ name: 'test-v1', transforms: [new VersionFilter('v1')] })
      const v2Server = new FastMCP({ name: 'test-v2', transforms: [new VersionFilter('v2')] })

      for (const s of [v1Server, v2Server]) {
        s.tool({ name: 'old_tool', description: 'Old', tags: ['v1'] }, () => 'old')
        s.tool({ name: 'new_tool', description: 'New', tags: ['v2'] }, () => 'new')
      }

      const v1Client = await makeClient(v1Server)
      const v2Client = await makeClient(v2Server)

      const { tools: v1Tools } = await v1Client.listTools()
      expect(v1Tools.map((t) => t.name)).toEqual(['old_tool'])

      const { tools: v2Tools } = await v2Client.listTools()
      expect(v2Tools.map((t) => t.name)).toEqual(['new_tool'])

      await v1Server.close()
      await v2Server.close()
    })
  })
})
