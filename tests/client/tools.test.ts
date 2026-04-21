import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod/v4'
import { FastMCP, Image } from 'fastmcp-ts/server'
import { Client, ToolCallError } from 'fastmcp-ts/client'
import type { Tool } from 'fastmcp-ts/client'

async function withServer(
  setup: (mcp: FastMCP) => void,
  fn: (client: Client) => Promise<void>,
) {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  setup(mcp)
  const client = await Client.connect(mcp)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

async function withServerExposed(
  setup: (mcp: FastMCP) => void,
  fn: (client: Client, mcp: FastMCP) => Promise<void>,
  clientOptions?: Parameters<typeof Client.connect>[1],
) {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  setup(mcp)
  const client = await Client.connect(mcp, clientOptions)
  try {
    await fn(client, mcp)
  } finally {
    await client.close()
  }
}

describe('Client — Tools', () => {
  describe('listTools()', () => {
    it('returns an array of tool definitions', async () => {
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'ping', description: 'a tool', input: z.object({}) }, () => 'pong')
        },
        async (client) => {
          const tools = await client.listTools()
          expect(tools).toBeInstanceOf(Array)
          expect(tools.length).toBeGreaterThan(0)
        },
      )
    })

    it('each definition includes name, description, and inputSchema', async () => {
      await withServer(
        (mcp) => {
          mcp.tool(
            { name: 'add', description: 'adds two numbers', input: z.object({ a: z.number(), b: z.number() }) },
            ({ a, b }) => a + b,
          )
        },
        async (client) => {
          const tools = await client.listTools()
          const add = tools.find((t) => t.name === 'add')
          expect(add).toBeDefined()
          expect(add!.description).toBe('adds two numbers')
          expect(add!.inputSchema).toBeDefined()
        },
      )
    })
  })

  describe('callTool()', () => {
    it('returns text content from the tool result', async () => {
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'greet', input: z.object({ name: z.string() }) }, ({ name }) => `hello ${name}`)
        },
        async (client) => {
          const result = await client.callTool('greet', { name: 'ada' })
          expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello ada' })
          expect(result.isError).toBe(false)
        },
      )
    })

    it('returns structured content when the tool provides it', async () => {
      await withServer(
        (mcp) => {
          mcp.tool(
            { name: 'data', input: z.object({}) },
            () => ({ value: 42, label: 'answer' }),
          )
        },
        async (client) => {
          const result = await client.callTool<{ value: number; label: string }>('data', {})
          expect(result.structuredContent).toMatchObject({ value: 42, label: 'answer' })
        },
      )
    })

    it('passes arguments to the server verbatim', async () => {
      const received: Record<string, unknown>[] = []
      await withServer(
        (mcp) => {
          mcp.tool(
            { name: 'spy', input: z.object({ x: z.number(), y: z.string() }) },
            (args) => { received.push(args); return 'ok' },
          )
        },
        async (client) => {
          await client.callTool('spy', { x: 7, y: 'hello' })
          expect(received[0]).toMatchObject({ x: 7, y: 'hello' })
        },
      )
    })

    it('throws ToolCallError when the server returns isError: true', async () => {
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'fail', input: z.object({}) }, () => {
            throw new Error('something went wrong')
          })
        },
        async (client) => {
          await expect(client.callTool('fail', {})).rejects.toBeInstanceOf(ToolCallError)
        },
      )
    })
  })

  describe('callToolRaw()', () => {
    it('returns the full result including isError without throwing', async () => {
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'fail', input: z.object({}) }, () => {
            throw new Error('oops')
          })
        },
        async (client) => {
          const result = await client.callToolRaw('fail', {})
          expect(result.isError).toBe(true)
          expect(result.content[0]).toMatchObject({ type: 'text' })
        },
      )
    })
  })
})

describe('Client — onToolsListChanged', () => {
  it('is called with the updated tool list when a tool is added after connect', async () => {
    const received: Array<{ error: Error | null; tools: Tool[] | null }> = []

    await withServerExposed(
      (mcp) => {
        mcp.tool({ name: 'initial', input: z.object({}) }, () => 'ok')
      },
      async (client, mcp) => {
        mcp.tool({ name: 'dynamic', input: z.object({}) }, () => 'added')
        await vi.waitFor(() => {
          expect(received.length).toBeGreaterThan(0)
        }, { timeout: 2000 })
        const last = received[received.length - 1]!
        expect(last.error).toBeNull()
        const names = last.tools?.map((t) => t.name) ?? []
        expect(names).toContain('dynamic')
      },
      {
        handlers: {
          onToolsListChanged: {
            onChanged: (error, tools) => { received.push({ error, tools }) },
            debounceMs: 0,
          },
        },
      },
    )
  })

  it('passes null items when autoRefresh is false', async () => {
    const received: Array<{ error: Error | null; tools: Tool[] | null }> = []

    await withServerExposed(
      () => {},
      async (client, mcp) => {
        mcp.tool({ name: 'new-tool', input: z.object({}) }, () => 'ok')
        await vi.waitFor(() => {
          expect(received.length).toBeGreaterThan(0)
        }, { timeout: 2000 })
        expect(received[0]!.tools).toBeNull()
      },
      {
        handlers: {
          onToolsListChanged: {
            onChanged: (error, tools) => { received.push({ error, tools }) },
            autoRefresh: false,
            debounceMs: 0,
          },
        },
      },
    )
  })
})
