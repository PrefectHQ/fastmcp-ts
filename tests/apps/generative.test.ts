import { describe, it, expect } from 'vitest'
import { FastMCP, GenerativeUI } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'
import { createUiTestClient } from '../helpers/createUiTestClient'

describe('Apps — Generative UI', () => {
  describe('LLM-driven rendering', () => {
    it('the LLM is given a generate_ui tool to generate and execute UI component code at runtime', async () => {
      const genUI = new GenerativeUI()
      const server = new FastMCP({ name: 'test' })
      server.addProvider(genUI)

      const { client, close } = await createTestClient(server)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).toContain('generate_ui')
      } finally {
        await close()
      }
    })

    it('the LLM is given a search_components tool to discover available component APIs and signatures', async () => {
      const genUI = new GenerativeUI()
      const server = new FastMCP({ name: 'test' })
      server.addProvider(genUI)

      const { client, close } = await createTestClient(server)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).toContain('search_components')

        // Returns the full component catalog with type and description per entry
        const result = await client.callTool({ name: 'search_components', arguments: {} })
        expect(result.isError).toBeFalsy()
        // The catalog is delivered as JSON text (structuredContent must be a plain object per MCP spec)
        const catalog = JSON.parse(((result.content as { text: string }[])[0]).text) as Array<{ type: string; description: string }>
        expect(Array.isArray(catalog)).toBe(true)
        expect(catalog.some((c) => c.type === 'column')).toBe(true)
        expect(catalog.some((c) => c.type === 'text')).toBe(true)
        expect(catalog.some((c) => c.type === 'button')).toBe(true)
        // Every entry has a description for the LLM to use
        expect(catalog.every((c) => typeof c.description === 'string')).toBe(true)
      } finally {
        await close()
      }
    })

    it('generated component code executes in an isolated sandbox', async () => {
      const genUI = new GenerativeUI()
      const server = new FastMCP({ name: 'test' })
      server.addProvider(genUI)

      const { client, close } = await createUiTestClient(server)
      try {
        // Valid component expression executes and returns the component tree
        const result = await client.callTool({
          name: 'generate_ui',
          arguments: { code: "Column({}, [Text('Hello from generative UI')])" },
        })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toEqual({
          type: 'column',
          children: [{ type: 'text', props: { content: 'Hello from generative UI' } }],
        })

        // Sandbox blocks access to Node.js built-ins
        const malicious = await client.callTool({
          name: 'generate_ui',
          arguments: { code: "require('fs').readFileSync('/etc/passwd', 'utf8')" },
        })
        expect(malicious.isError).toBe(true)
      } finally {
        await close()
      }
    })
  })

  describe('server integration', () => {
    it('GenerativeUI can be registered as a provider on a FastMCP server', async () => {
      const genUI = new GenerativeUI()
      const server = new FastMCP({ name: 'test' })
      server.addProvider(genUI)

      const { client, close } = await createTestClient(server)
      try {
        const tools = await client.listTools()
        const names = tools.tools.map((t) => t.name)
        expect(names).toContain('generate_ui')
        expect(names).toContain('search_components')
      } finally {
        await close()
      }
    })

    it('its tools are scoped and do not conflict with user-defined tools', async () => {
      const genUI = new GenerativeUI()
      const server = new FastMCP({ name: 'test' })
      server.tool({ name: 'my_tool', description: 'My tool' }, () => 'result')
      server.addProvider(genUI)

      const { client, close } = await createTestClient(server)
      try {
        const tools = await client.listTools()
        const names = tools.tools.map((t) => t.name)
        expect(names).toContain('my_tool')
        expect(names).toContain('generate_ui')
        expect(names).toContain('search_components')
      } finally {
        await close()
      }
    })
  })
})
