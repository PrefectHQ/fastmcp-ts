import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types'
import { FastMCP, Image, File, ToolResult } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a server + connected in-memory client. Close both in afterEach via `close()`. */
async function setup(mcp?: FastMCP) {
  const server = mcp ?? new FastMCP({ name: 'test' })
  const { client, close } = await createTestClient(server)
  return { server, client, close }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Server — Tools', () => {
  describe('declaration', () => {
    it('a function registered as a tool is discoverable by clients via listTools', async () => {
      const { client, close } = await setup()

      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'greet', description: 'Say hello' }, () => 'hello')
      const { client: c2, close: close2 } = await setup(mcp)

      try {
        const result = await c2.listTools()
        expect(result.tools).toHaveLength(1)
        expect(result.tools[0].name).toBe('greet')
      } finally {
        await close()
        await close2()
      }
    })

    it('name and description are inferred from the function when not provided in config', async () => {
      const mcp = new FastMCP({ name: 'test' })
      function getWeather() {
        return 'sunny'
      }
      mcp.tool({}, getWeather)

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        expect(result.tools).toHaveLength(1)
        expect(result.tools[0].name).toBe('getWeather')
        expect(result.tools[0].description).toBe('get weather')
      } finally {
        await close()
      }
    })

    it('an input schema provided as a Standard Schema validator is serialised as inputSchema for clients', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'add', input: z.object({ a: z.number(), b: z.number() }) },
        ({ a, b }) => a + b,
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        const tool = result.tools[0]
        expect(tool.inputSchema.type).toBe('object')
        expect((tool.inputSchema as Record<string, unknown>).properties).toMatchObject({
          a: { type: 'number' },
          b: { type: 'number' },
        })
        expect((tool.inputSchema as Record<string, unknown>).required).toContain('a')
        expect((tool.inputSchema as Record<string, unknown>).required).toContain('b')
      } finally {
        await close()
      }
    })

    it('an output schema provided as a Standard Schema validator is advertised as outputSchema for clients', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        {
          name: 'getUser',
          output: z.object({ id: z.number(), name: z.string() }),
        },
        () => ({ id: 1, name: 'Alice' }),
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        const tool = result.tools[0]
        expect(tool.outputSchema).toBeDefined()
        expect((tool.outputSchema as Record<string, unknown>)?.type).toBe('object')
        expect(
          (tool.outputSchema as Record<string, unknown>)?.properties as Record<string, unknown>,
        ).toMatchObject({
          id: { type: 'number' },
          name: { type: 'string' },
        })
      } finally {
        await close()
      }
    })

    it('explicit name, description, and metadata in config override any inferred values', async () => {
      const mcp = new FastMCP({ name: 'test' })
      function getWeather() {
        return 'sunny'
      }
      mcp.tool(
        { name: 'fetch-weather', description: 'Fetch current weather conditions' },
        getWeather,
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        const tool = result.tools[0]
        expect(tool.name).toBe('fetch-weather')
        expect(tool.description).toBe('Fetch current weather conditions')
      } finally {
        await close()
      }
    })
  })

  describe('execution', () => {
    it('a synchronous handler executes and returns its result to the client', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping' }, () => 'pong')

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'ping', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.content).toEqual([{ type: 'text', text: 'pong' }])
      } finally {
        await close()
      }
    })

    it('an async handler is awaited and its result returned to the client', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'fetch' }, async () => {
        await new Promise((r) => setTimeout(r, 10))
        return 'fetched'
      })

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'fetch', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.content).toEqual([{ type: 'text', text: 'fetched' }])
      } finally {
        await close()
      }
    })

    it('an exception thrown by the handler is returned as an error result, not a server crash', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'explode' }, () => {
        throw new Error('kaboom')
      })

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'explode', arguments: {} })
        expect(result.isError).toBe(true)
        expect((result.content[0] as { type: string; text: string }).text).toBe('kaboom')
        // Server should still be usable after an error
        const again = await client.callTool({ name: 'explode', arguments: {} })
        expect(again.isError).toBe(true)
      } finally {
        await close()
      }
    })

    it('a handler that exceeds its configured timeout returns a timeout error to the client', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'slow', timeout: 50 },
        () => new Promise((r) => setTimeout(r, 5000)),
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'slow', arguments: {} })
        expect(result.isError).toBe(true)
        expect((result.content[0] as { type: string; text: string }).text).toMatch(/timed out/)
      } finally {
        await close()
      }
    })
  })

  describe('input handling', () => {
    it('arguments are validated against the Standard Schema before the handler is called', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const handlerSpy = vi.fn(() => 'ok')
      mcp.tool(
        { name: 'typed', input: z.object({ x: z.number() }) },
        handlerSpy,
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'typed', arguments: { x: 'not-a-number' } })
        expect(result.isError).toBe(true)
        expect(handlerSpy).not.toHaveBeenCalled()
      } finally {
        await close()
      }
    })

    it('a call with missing required parameters is rejected before the handler runs', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const handlerSpy = vi.fn(() => 'ok')
      mcp.tool(
        { name: 'greet', input: z.object({ name: z.string() }) },
        handlerSpy,
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'greet', arguments: {} })
        expect(result.isError).toBe(true)
        expect(handlerSpy).not.toHaveBeenCalled()
      } finally {
        await close()
      }
    })

    it('optional parameters receive their default values when omitted', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'greet', input: z.object({ name: z.string().default('world') }) },
        ({ name }) => `hello, ${name}`,
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'greet', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.content).toEqual([{ type: 'text', text: 'hello, world' }])
      } finally {
        await close()
      }
    })

    it('the validated, typed arguments are passed to the handler — not the raw unvalidated input', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let received: unknown
      mcp.tool(
        { name: 'typed', input: z.object({ n: z.coerce.number() }) },
        ({ n }) => {
          received = n
          return n
        },
      )

      const { client, close } = await setup(mcp)
      try {
        await client.callTool({ name: 'typed', arguments: { n: '42' } })
        // After coercion the handler receives a number, not the string "42"
        expect(typeof received).toBe('number')
        expect(received).toBe(42)
      } finally {
        await close()
      }
    })
  })

  describe('return value conversion', () => {
    async function callTool(handler: () => unknown) {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'x' }, handler)
      const { client, close } = await setup(mcp)
      try {
        return await client.callTool({ name: 'x', arguments: {} })
      } finally {
        await close()
      }
    }

    it('a string return becomes a single text content block', async () => {
      const result = await callTool(() => 'hello')
      expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('a number return is stringified into a text content block', async () => {
      const result = await callTool(() => 42)
      expect(result.content).toEqual([{ type: 'text', text: '42' }])
    })

    it('a boolean return is stringified into a text content block', async () => {
      const result = await callTool(() => true)
      expect(result.content).toEqual([{ type: 'text', text: 'true' }])
    })

    it('undefined or void returns an empty content list', async () => {
      const result = await callTool(() => undefined)
      expect(result.content).toEqual([])
    })

    it('a plain object return produces a JSON text block and populates structuredContent', async () => {
      const result = await callTool(() => ({ a: 1, b: 'two' }))
      expect(result.content).toEqual([{ type: 'text', text: '{"a":1,"b":"two"}' }])
      expect(result.structuredContent).toEqual({ a: 1, b: 'two' })
    })

    it('an array return produces a JSON text block', async () => {
      const result = await callTool(() => [1, 2, 3])
      expect(result.content).toEqual([{ type: 'text', text: '[1,2,3]' }])
    })

    it('an Image(buffer, mimeType) return produces an image content block', async () => {
      const buf = Buffer.from('fake-png-data')
      const result = await callTool(() => new Image(buf, 'image/png'))
      expect(result.content).toHaveLength(1)
      const block = result.content[0] as { type: string; data: string; mimeType: string }
      expect(block.type).toBe('image')
      expect(block.mimeType).toBe('image/png')
      expect(block.data).toBe(buf.toString('base64'))
    })

    it('a File(buffer, name, mimeType) return produces a resource content block with the correct MIME type', async () => {
      const buf = Buffer.from('%PDF-1.4 ...')
      const result = await callTool(() => new File(buf, 'report.pdf', 'application/pdf'))
      expect(result.content).toHaveLength(1)
      const block = result.content[0] as {
        type: string
        resource: { uri: string; mimeType: string; blob: string }
      }
      expect(block.type).toBe('resource')
      expect(block.resource.mimeType).toBe('application/pdf')
      expect(block.resource.blob).toBe(buf.toString('base64'))
      expect(block.resource.uri).toContain('report.pdf')
    })

    it('a ToolResult return is passed through as-is, bypassing all automatic conversion', async () => {
      const customContent = [
        { type: 'text' as const, text: 'part 1' },
        { type: 'text' as const, text: 'part 2' },
      ]
      const result = await callTool(
        () => new ToolResult({ content: customContent, isError: false }),
      )
      expect(result.content).toEqual(customContent)
      expect(result.isError).toBe(false)
    })
  })

  describe('visibility', () => {
    it('a tool registered with disabled: true does not appear in listTools responses', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'visible' }, () => 'yes')
      mcp.tool({ name: 'hidden', disabled: true }, () => 'shh')

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        const names = result.tools.map((t) => t.name)
        expect(names).toContain('visible')
        expect(names).not.toContain('hidden')
      } finally {
        await close()
      }
    })

    it('a disabled tool remains callable when invoked directly', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'hidden', disabled: true }, () => 'secret')

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'hidden', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.content).toEqual([{ type: 'text', text: 'secret' }])
      } finally {
        await close()
      }
    })

    it('listTools can be filtered to tools matching a given tag', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'alpha', tags: ['math'] }, () => 1)
      mcp.tool({ name: 'beta', tags: ['text'] }, () => 'b')
      mcp.tool({ name: 'gamma', tags: ['math', 'text'] }, () => 'g')

      const { client, close } = await setup(mcp)
      try {
        // Without filtering all tools appear
        const all = await client.listTools()
        expect(all.tools.map((t) => t.name).sort()).toEqual(['alpha', 'beta', 'gamma'])
      } finally {
        await close()
      }
    })
  })

  describe('dynamic registration', () => {
    it('a tool registered after run() is immediately visible to clients via listTools', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'first' }, () => 1)

      const { client, close } = await setup(mcp)
      try {
        const before = await client.listTools()
        expect(before.tools.map((t) => t.name)).toEqual(['first'])

        // Register a second tool while the client is already connected
        mcp.tool({ name: 'second' }, () => 2)

        const after = await client.listTools()
        expect(after.tools.map((t) => t.name)).toContain('second')
      } finally {
        await close()
      }
    })

    it('registering a tool on a running server emits a tools/list_changed notification', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const { client, close } = await setup(mcp)

      try {
        const notified = new Promise<void>((resolve) => {
          client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            resolve()
          })
        })

        mcp.tool({ name: 'new-tool' }, () => 'hi')

        // Notification should arrive within a reasonable time
        await expect(notified).resolves.toBeUndefined()
      } finally {
        await close()
      }
    })
  })
})
