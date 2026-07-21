import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FastMCP } from '../../src/server/FastMCP'
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  renameTool,
  redescribeTool,
  FilterTransform,
  NamespaceTransform,
  ResourcesAsTools,
  PromptsAsTools,
  VersionFilter,
} from '../../src/server/transform'
import type { SynthesizedTool } from '../../src/server/transform'

async function makeClient(server: FastMCP): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

describe('Server — Transforms', () => {
  let server: FastMCP
  let client: Client | undefined

  afterEach(async () => {
    await client?.close()
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

    it('a tool can still be called by its original name after being renamed', async () => {
      server = new FastMCP({ name: 'test', transforms: [renameTool('get_weather', 'weather')] })
      server.tool({ name: 'get_weather', description: 'Get weather' }, () => 'sunny')
      client = await makeClient(server)

      const result = await client.callTool({ name: 'get_weather', arguments: {} })
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

    it('a transform can hide specific resources from the list seen by clients', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [new FilterTransform({ resources: (v) => !v.uri.includes('private') })],
      })
      server.resource({ uri: 'public://data', name: 'Public' }, () => 'ok')
      server.resource({ uri: 'private://secret', name: 'Secret' }, () => 'hidden')
      client = await makeClient(server)

      const { resources } = await client.listResources()
      expect(resources.map((r) => r.uri)).toContain('public://data')
      expect(resources.map((r) => r.uri)).not.toContain('private://secret')
    })

    it('hidden resources remain readable by their original URI', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [new FilterTransform({ resources: (v) => !v.uri.includes('private') })],
      })
      server.resource({ uri: 'private://secret', name: 'Secret' }, () => 'hidden content')
      client = await makeClient(server)

      const result = await client.readResource({ uri: 'private://secret' })
      expect(result.contents[0]).toMatchObject({ text: 'hidden content' })
    })

    it('a transform can hide specific prompts from the list seen by clients', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [new FilterTransform({ prompts: (v) => v.name !== 'internal_prompt' })],
      })
      server.prompt({ name: 'public_prompt', description: 'Public' }, () => 'hello')
      server.prompt({ name: 'internal_prompt', description: 'Internal' }, () => 'secret')
      client = await makeClient(server)

      const { prompts } = await client.listPrompts()
      expect(prompts.map((p) => p.name)).toContain('public_prompt')
      expect(prompts.map((p) => p.name)).not.toContain('internal_prompt')
    })

    it('hidden prompts remain invokable by their original name', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [new FilterTransform({ prompts: (v) => v.name !== 'internal_prompt' })],
      })
      server.prompt({ name: 'internal_prompt', description: 'Internal' }, () => 'secret message')
      client = await makeClient(server)

      const result = await client.getPrompt({ name: 'internal_prompt' })
      expect(result.messages[0].content).toEqual({ type: 'text', text: 'secret message' })
    })

    it('resourceTemplates predicate is independent from resources predicate', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [new FilterTransform({ resourceTemplates: () => false })],
      })
      server.resource({ uri: 'static://data', name: 'Static' }, () => 'static')
      server.resource({ uri: 'template://{id}', name: 'Template' }, () => 'templated')
      client = await makeClient(server)

      const { resources } = await client.listResources()
      expect(resources.map((r) => r.uri)).toContain('static://data')

      const { resourceTemplates } = await client.listResourceTemplates()
      expect(resourceTemplates).toHaveLength(0)
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

    it('a tool title is passed through to the client and a transform can rewrite it', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [
          {
            transformTool: (v) => (v.name === 'get_weather' ? { ...v, title: 'Fetch Weather' } : v),
          },
        ],
      })
      server.tool({ name: 'get_weather', title: 'Get Current Weather', description: 'Get weather' }, () => 'sunny')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === 'get_weather')
      expect(tool?.title).toBe('Fetch Weather')
    })

    it('a tool with no title has no title field in the list response', async () => {
      server = new FastMCP({ name: 'test' })
      server.tool({ name: 'search', description: 'Search' }, () => 'results')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      expect('title' in tools[0]).toBe(false)
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
      const listed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as Array<{ uri: string; name: string }>
      expect(listed).toHaveLength(2)
      expect(listed.find((r) => r.uri === 'docs://guide')?.name).toBe('Guide')
      expect(listed.find((r) => r.uri === 'docs://readme')?.name).toBe('Readme')
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

    it('ResourcesAsTools combined with NamespaceTransform preserves original URIs and prefixes names', async () => {
      server = new FastMCP({ name: 'test', transforms: [new NamespaceTransform('v1_'), new ResourcesAsTools()] })
      server.resource({ uri: 'data://items', name: 'Items' }, () => 'items')
      client = await makeClient(server)

      const result = await client.callTool({ name: 'v1_list_resources', arguments: {} })
      const listed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as Array<{ uri: string; name: string }>
      expect(listed[0].uri).toBe('data://items')
      expect(listed[0].name).toBe('v1_Items')
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

    it('a synthesized tool with an auth check rejects unauthorised callers', async () => {
      const { AuthorizationError } = await import('../../src/server/auth/types')
      const guardedTransform = {
        synthesizeTools: (): SynthesizedTool[] => [
          {
            name: 'guarded',
            description: 'Guarded',
            auth: () => { throw new AuthorizationError('forbidden') },
            handler: () => 'secret',
          },
        ],
      }
      server = new FastMCP({ name: 'test', transforms: [guardedTransform] })
      client = await makeClient(server)

      await expect(client.callTool({ name: 'guarded', arguments: {} })).rejects.toThrow()
    })

    it('a synthesized tool with a timeout returns an error when it exceeds the limit', async () => {
      const slowTransform = {
        synthesizeTools: (): SynthesizedTool[] => [
          {
            name: 'slow',
            description: 'Slow',
            timeout: 50,
            handler: () => new Promise((resolve) => setTimeout(() => resolve('done'), 300)),
          },
        ],
      }
      server = new FastMCP({ name: 'test', transforms: [slowTransform] })
      client = await makeClient(server)

      const result = await client.callTool({ name: 'slow', arguments: {} })
      expect(result.isError).toBe(true)
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toMatch(/timed out/)
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
      expect(resources[0].uri).toBe('data://items')

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

    it('NamespaceTransform does not alter resource URIs — resources are read by their original URI', async () => {
      server = new FastMCP({ name: 'test', transforms: [new NamespaceTransform('v1_')] })
      server.resource({ uri: 'data://items', name: 'Items' }, () => 'item content')
      client = await makeClient(server)

      const result = await client.readResource({ uri: 'data://items' })
      expect(result.contents[0]).toMatchObject({ text: 'item content' })
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

    it('version filter exposes only resources whose tags match the configured version', async () => {
      server = new FastMCP({ name: 'test', transforms: [new VersionFilter('v2')] })
      server.resource({ uri: 'res://v1', name: 'V1 resource', tags: ['v1'] }, () => 'v1')
      server.resource({ uri: 'res://v2', name: 'V2 resource', tags: ['v2'] }, () => 'v2')
      server.resource({ uri: 'res://untagged', name: 'Untagged' }, () => 'no tag')
      client = await makeClient(server)

      const { resources } = await client.listResources()
      const uris = resources.map((r) => r.uri)
      expect(uris).toContain('res://v2')
      expect(uris).not.toContain('res://v1')
      expect(uris).not.toContain('res://untagged')
    })

    it('version filter exposes only prompts whose tags match the configured version', async () => {
      server = new FastMCP({ name: 'test', transforms: [new VersionFilter('v2')] })
      server.prompt({ name: 'old_prompt', description: 'Old', tags: ['v1'] }, () => 'old')
      server.prompt({ name: 'new_prompt', description: 'New', tags: ['v2'] }, () => 'new')
      client = await makeClient(server)

      const { prompts } = await client.listPrompts()
      const names = prompts.map((p) => p.name)
      expect(names).toContain('new_prompt')
      expect(names).not.toContain('old_prompt')
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

  describe('transform chain interactions', () => {
    it('FilterTransform before NamespaceTransform: filtered items do not appear under their namespaced names', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [
          new FilterTransform({ tools: (v) => v.name !== 'hidden' }),
          new NamespaceTransform('ns_'),
        ],
      })
      server.tool({ name: 'visible', description: 'Visible' }, () => 'yes')
      server.tool({ name: 'hidden', description: 'Hidden' }, () => 'no')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('ns_visible')
      expect(names).not.toContain('ns_hidden')
      expect(names).not.toContain('hidden')
    })

    it('NamespaceTransform before FilterTransform: filter predicate receives already-namespaced names', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [
          new NamespaceTransform('ns_'),
          new FilterTransform({ tools: (v) => !v.name.startsWith('ns_internal') }),
        ],
      })
      server.tool({ name: 'public', description: 'Public' }, () => 'ok')
      server.tool({ name: 'internal', description: 'Internal' }, () => 'hidden')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('ns_public')
      expect(names).not.toContain('ns_internal')
    })

    it('renameTool + VersionFilter: renamed tool retains its original tags for version filtering', async () => {
      server = new FastMCP({
        name: 'test',
        transforms: [renameTool('tool_v2', 'renamed_v2'), new VersionFilter('v2')],
      })
      server.tool({ name: 'tool_v2', description: 'V2 tool', tags: ['v2'] }, () => 'v2')
      server.tool({ name: 'tool_v1', description: 'V1 tool', tags: ['v1'] }, () => 'v1')
      client = await makeClient(server)

      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('renamed_v2')
      expect(names).not.toContain('tool_v1')
    })
  })
})
