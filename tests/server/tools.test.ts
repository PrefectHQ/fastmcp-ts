import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { McpError, ErrorCode, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types'
import { FastMCP, Image, File, ToolResult } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'greet', description: 'Say hello' }, () => 'hello')
      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        expect(result.tools).toHaveLength(1)
        expect(result.tools[0].name).toBe('greet')
      } finally {
        await close()
      }
    })

    it('an input schema provided as a Standard Schema validator is serialised as inputSchema for clients', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'add', description: 'Add two numbers', input: z.object({ a: z.number(), b: z.number() }) },
        ({ a, b }) => a + b,
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        const schema = result.tools[0].inputSchema as Record<string, unknown>
        expect(schema.type).toBe('object')
        expect((schema.properties as Record<string, unknown>)).toMatchObject({
          a: { type: 'number' },
          b: { type: 'number' },
        })
        expect(schema.required).toContain('a')
        expect(schema.required).toContain('b')
      } finally {
        await close()
      }
    })

    it('an explicit inputSchema in config overrides auto-generation and suppresses warnings', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // A fake non-Zod Standard Schema — auto-generation would warn and fall back
        const fakeSchema = {
          '~standard': { version: 1 as const, vendor: 'fake', validate: (v: unknown) => ({ value: v }) },
        }
        mcp.tool(
          {
            name: 'typed',
            description: 'test tool',
            input: fakeSchema,
            inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          },
          () => 'ok',
        )

        const { client, close } = await setup(mcp)
        try {
          const result = await client.listTools()
          const schema = result.tools[0].inputSchema as Record<string, unknown>
          expect((schema.properties as Record<string, unknown>)).toMatchObject({ x: { type: 'number' } })
          // No warning should have been emitted (explicit schema took precedence)
          expect(warnSpy).not.toHaveBeenCalled()
        } finally {
          await close()
        }
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('an output schema provided as a Standard Schema validator is advertised as outputSchema for clients', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'getUser', description: 'Get a user', output: z.object({ id: z.number(), name: z.string() }) },
        () => ({ id: 1, name: 'Alice' }),
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        const outputSchema = result.tools[0].outputSchema as Record<string, unknown> | undefined
        expect(outputSchema).toBeDefined()
        expect(outputSchema?.type).toBe('object')
        expect((outputSchema?.properties as Record<string, unknown>)).toMatchObject({
          id: { type: 'number' },
          name: { type: 'string' },
        })
      } finally {
        await close()
      }
    })

    it('name and description from config are passed through to clients verbatim', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'fetch-weather', description: 'Fetch current weather conditions' },
        () => 'sunny',
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        expect(result.tools[0].name).toBe('fetch-weather')
        expect(result.tools[0].description).toBe('Fetch current weather conditions')
      } finally {
        await close()
      }
    })

    it('tools/list paginates when the tool count exceeds toolsPageSize', async () => {
      const mcp = new FastMCP({ name: 'test', toolsPageSize: 2 })
      mcp.tool({ name: 'alpha', description: 'test tool' }, () => 1)
      mcp.tool({ name: 'beta', description: 'test tool' }, () => 2)
      mcp.tool({ name: 'gamma', description: 'test tool' }, () => 3)

      const { client, close } = await setup(mcp)
      try {
        // First page
        const page1 = await client.listTools()
        expect(page1.tools.map((t) => t.name)).toEqual(['alpha', 'beta'])
        expect(page1.nextCursor).toBeDefined()

        // Second page
        const page2 = await client.listTools({ cursor: page1.nextCursor! })
        expect(page2.tools.map((t) => t.name)).toEqual(['gamma'])
        expect(page2.nextCursor).toBeUndefined()
      } finally {
        await close()
      }
    })

    it('tools/list returns all tools on a single page when count is within toolsPageSize', async () => {
      const mcp = new FastMCP({ name: 'test', toolsPageSize: 10 })
      mcp.tool({ name: 'alpha', description: 'test tool' }, () => 1)
      mcp.tool({ name: 'beta', description: 'test tool' }, () => 2)

      const { client, close } = await setup(mcp)
      try {
        const result = await client.listTools()
        expect(result.tools).toHaveLength(2)
        expect(result.nextCursor).toBeUndefined()
      } finally {
        await close()
      }
    })

    it('an invalid or stale cursor throws an InvalidParams error', async () => {
      const mcp = new FastMCP({ name: 'test', toolsPageSize: 2 })
      mcp.tool({ name: 'alpha', description: 'test tool' }, () => 1)
      mcp.tool({ name: 'beta', description: 'test tool' }, () => 2)

      const { client, close } = await setup(mcp)
      try {
        await expect(
          client.listTools({ cursor: Buffer.from('nonexistent-tool').toString('base64url') }),
        ).rejects.toThrow()
      } finally {
        await close()
      }
    })
  })

  describe('execution', () => {
    it('a synchronous handler executes and returns its result to the client', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'test tool' }, () => 'pong')

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
      mcp.tool({ name: 'fetch', description: 'test tool' }, async () => {
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
      mcp.tool({ name: 'explode', description: 'test tool' }, () => {
        throw new Error('kaboom')
      })

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'explode', arguments: {} })
        expect(result.isError).toBe(true)
        expect(((result.content as unknown[])[0] as { type: string; text: string }).text).toBe('kaboom')
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
        { name: 'slow', description: 'test tool', timeout: 50 },
        () => new Promise((r) => setTimeout(r, 5000)),
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'slow', arguments: {} })
        expect(result.isError).toBe(true)
        expect(((result.content as unknown[])[0] as { type: string; text: string }).text).toMatch(/timed out/)
      } finally {
        await close()
      }
    })

    it('the timeout timer is cleared after a successful call', async () => {
      // If the timer leaked, the test runner would hang or show open handles.
      // A successful fast call with a timeout configured should complete cleanly.
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'fast', description: 'test tool', timeout: 1000 }, () => 'done')

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'fast', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.content).toEqual([{ type: 'text', text: 'done' }])
      } finally {
        await close()
      }
    })
  })

  describe('input handling', () => {
    it('arguments are validated against the Standard Schema before the handler is called', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const handlerSpy = vi.fn(() => 'ok')
      mcp.tool({ name: 'typed', description: 'test tool', input: z.object({ x: z.number() }) }, handlerSpy)

      const { client, close } = await setup(mcp)
      try {
        await expect(
          client.callTool({ name: 'typed', arguments: { x: 'not-a-number' } }),
        ).rejects.toThrow()
        expect(handlerSpy).not.toHaveBeenCalled()
      } finally {
        await close()
      }
    })

    it('a call with missing required parameters is rejected before the handler runs', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const handlerSpy = vi.fn(() => 'ok')
      mcp.tool({ name: 'greet', description: 'test tool', input: z.object({ name: z.string() }) }, handlerSpy)

      const { client, close } = await setup(mcp)
      try {
        await expect(
          client.callTool({ name: 'greet', arguments: {} }),
        ).rejects.toThrow()
        expect(handlerSpy).not.toHaveBeenCalled()
      } finally {
        await close()
      }
    })

    it('invalid arguments produce an InvalidParams protocol error, not an isError tool result', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'typed', description: 'test tool', input: z.object({ x: z.string() }) }, ({ x }) => x)

      const { client, close } = await setup(mcp)
      try {
        const err = await client.callTool({ name: 'typed', arguments: { x: 42 } }).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(McpError)
        expect((err as McpError).code).toBe(ErrorCode.InvalidParams)
        expect((err as McpError).message).toMatch(/Validation failed/)
      } finally {
        await close()
      }
    })

    it('optional parameters receive their default values when omitted', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'greet', description: 'test tool', input: z.object({ name: z.string().default('world') }) },
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
        { name: 'typed', description: 'test tool', input: z.object({ n: z.coerce.number() }) },
        ({ n }) => {
          received = n
          return n
        },
      )

      const { client, close } = await setup(mcp)
      try {
        await client.callTool({ name: 'typed', arguments: { n: '42' } })
        expect(typeof received).toBe('number')
        expect(received).toBe(42)
      } finally {
        await close()
      }
    })
  })

  describe('output schema', () => {
    it('a handler whose return value matches the output schema succeeds', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'greet', description: 'test tool', output: z.string() },
        () => 'hello',
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'greet', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
      } finally {
        await close()
      }
    })

    it('a handler whose return value violates the output schema returns an error result', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'typed', description: 'test tool', output: z.string() },
        () => 42 as unknown as string, // deliberate mismatch
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'typed', arguments: {} })
        expect(result.isError).toBe(true)
      } finally {
        await close()
      }
    })

    it('output validation applies before result conversion — primitives and objects are both valid', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'count', description: 'test tool', output: z.number() },
        () => 7,
      )

      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'count', arguments: {} })
        expect(result.isError).toBeFalsy()
        // After validation, the number still goes through convertResult → text block
        expect(result.content).toEqual([{ type: 'text', text: '7' }])
      } finally {
        await close()
      }
    })
  })

  describe('return value conversion', () => {
    async function callTool(handler: () => unknown) {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'x', description: 'test tool' }, handler)
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
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const result = await callTool(() => [1, 2, 3])
        expect(result.content).toEqual([{ type: 'text', text: '[1,2,3]' }])
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('structuredContent will not be set'))
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('an Image(buffer, mimeType) return produces an image content block', async () => {
      const buf = Buffer.from('fake-png-data')
      const result = await callTool(() => new Image(buf, 'image/png'))
      expect((result.content as unknown[]).length).toBe(1)
      const block = (result.content as unknown[])[0] as { type: string; data: string; mimeType: string }
      expect(block.type).toBe('image')
      expect(block.mimeType).toBe('image/png')
      expect(block.data).toBe(buf.toString('base64'))
    })

    it('a File(buffer, name, mimeType) return produces a resource content block with the correct MIME type', async () => {
      const buf = Buffer.from('%PDF-1.4 ...')
      const result = await callTool(() => new File(buf, 'report.pdf', 'application/pdf'))
      expect((result.content as unknown[]).length).toBe(1)
      const block = (result.content as unknown[])[0] as {
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
      mcp.tool({ name: 'visible', description: 'test tool' }, () => 'yes')
      mcp.tool({ name: 'hidden', description: 'test tool', disabled: true }, () => 'shh')

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

    it('a disabled tool cannot be invoked and rejects with an error', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'hidden', description: 'test tool', disabled: true }, () => 'secret')

      const { client, close } = await setup(mcp)
      try {
        await expect(
          client.callTool({ name: 'hidden', arguments: {} }),
        ).rejects.toThrow()
      } finally {
        await close()
      }
    })

    it('listTools can be filtered to tools matching a given tag', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'alpha', description: 'test tool', tags: ['math'] }, () => 1)
      mcp.tool({ name: 'beta', description: 'test tool', tags: ['text'] }, () => 'b')
      mcp.tool({ name: 'gamma', description: 'test tool', tags: ['math', 'text'] }, () => 'g')

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
      mcp.tool({ name: 'first', description: 'test tool' }, () => 1)

      const { client, close } = await setup(mcp)
      try {
        const before = await client.listTools()
        expect(before.tools.map((t) => t.name)).toEqual(['first'])

        mcp.tool({ name: 'second', description: 'test tool' }, () => 2)

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

        mcp.tool({ name: 'new-tool', description: 'test tool' }, () => 'hi')

        await expect(notified).resolves.toBeUndefined()
      } finally {
        await close()
      }
    })
  })
})
