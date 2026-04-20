import { describe, it, expect, vi } from 'vitest'
import { FastMCP, PromptResult } from 'fastmcp-ts/server'
import type { PromptMessage } from 'fastmcp-ts/server'
import { PromptListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types'
import { createTestClient } from '../helpers/createTestClient'

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

describe('Server — Prompts', () => {
  describe('declaration', () => {
    it('a registered prompt is discoverable via prompts/list', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'greet', description: 'A greeting prompt' }, () => 'Hello!')
      const { client, close } = await createTestClient(mcp)
      try {
        const { prompts } = await client.listPrompts()
        expect(prompts).toHaveLength(1)
        expect(prompts[0].name).toBe('greet')
        expect(prompts[0].description).toBe('A greeting prompt')
      } finally {
        await close()
      }
    })

    it('name is inferred from the handler function name when not provided in config', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({}, function reviewCode() { return 'Review this code' })
      const { client, close } = await createTestClient(mcp)
      try {
        const { prompts } = await client.listPrompts()
        expect(prompts[0].name).toBe('reviewCode')
      } finally {
        await close()
      }
    })

    it('description is inferred from the handler function name when not provided in config', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({}, function reviewCode() { return 'ok' })
      const { client, close } = await createTestClient(mcp)
      try {
        const { prompts } = await client.listPrompts()
        expect(prompts[0].description).toBe('review code')
      } finally {
        await close()
      }
    })

    it('title is forwarded in list responses when provided', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'greet', title: 'Greeting Prompt', description: 'desc' }, () => 'hi')
      const { client, close } = await createTestClient(mcp)
      try {
        const { prompts } = await client.listPrompts()
        expect((prompts[0] as Record<string, unknown>).title).toBe('Greeting Prompt')
      } finally {
        await close()
      }
    })

    it('arguments declared in config are advertised to clients', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt(
        {
          name: 'review',
          description: 'Review code',
          arguments: [
            { name: 'code', description: 'Code to review', required: true },
            { name: 'language', description: 'Language hint', required: false },
          ],
        },
        () => 'ok',
      )
      const { client, close } = await createTestClient(mcp)
      try {
        const { prompts } = await client.listPrompts()
        expect(prompts[0].arguments).toMatchObject([
          { name: 'code', required: true },
          { name: 'language', required: false },
        ])
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  describe('execution', () => {
    it('a string return is delivered as a single user text message', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'hello', description: 'test' }, () => 'Hello, world!')
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.getPrompt({ name: 'hello', arguments: {} })
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0].role).toBe('user')
        expect(result.messages[0].content).toEqual({ type: 'text', text: 'Hello, world!' })
      } finally {
        await close()
      }
    })

    it('a PromptMessage return is delivered directly', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const msg: PromptMessage = { role: 'assistant', content: { type: 'text', text: 'I can help.' } }
      mcp.prompt({ name: 'assist', description: 'test' }, () => msg)
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.getPrompt({ name: 'assist', arguments: {} })
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0].role).toBe('assistant')
      } finally {
        await close()
      }
    })

    it('an array return is delivered as a multi-turn message sequence', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const messages: PromptMessage[] = [
        { role: 'user', content: { type: 'text', text: 'Explain this code.' } },
        { role: 'assistant', content: { type: 'text', text: 'Sure, here is the explanation.' } },
        { role: 'user', content: { type: 'text', text: 'Can you simplify it?' } },
      ]
      mcp.prompt({ name: 'explain', description: 'test' }, () => messages)
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.getPrompt({ name: 'explain', arguments: {} })
        expect(result.messages).toHaveLength(3)
        expect(result.messages[0].role).toBe('user')
        expect(result.messages[1].role).toBe('assistant')
        expect(result.messages[2].role).toBe('user')
      } finally {
        await close()
      }
    })

    it('a PromptResult return is used as-is (escape hatch for description + custom messages)', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'custom', description: 'test' }, () =>
        new PromptResult(
          [{ role: 'user', content: { type: 'text', text: 'Custom prompt text' } }],
          'Rendered description',
        ),
      )
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.getPrompt({ name: 'custom', arguments: {} })
        expect(result.description).toBe('Rendered description')
        expect(result.messages[0].content).toEqual({ type: 'text', text: 'Custom prompt text' })
      } finally {
        await close()
      }
    })

    it('async prompt functions are awaited before the response is sent', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'slow', description: 'test' }, async () => {
        await new Promise((r) => setTimeout(r, 10))
        return 'async result'
      })
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.getPrompt({ name: 'slow', arguments: {} })
        expect((result.messages[0].content as { text: string }).text).toBe('async result')
      } finally {
        await close()
      }
    })

    it('missing a required argument returns an error before the handler runs', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const spy = vi.fn(() => 'ok')
      mcp.prompt(
        {
          name: 'review',
          description: 'test',
          arguments: [{ name: 'code', required: true }],
        },
        spy,
      )
      const { client, close } = await createTestClient(mcp)
      try {
        await expect(client.getPrompt({ name: 'review', arguments: {} })).rejects.toThrow()
        expect(spy).not.toHaveBeenCalled()
      } finally {
        await close()
      }
    })

    it('optional arguments are omitted without error', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let received: Record<string, string> | undefined
      mcp.prompt(
        {
          name: 'review',
          description: 'test',
          arguments: [
            { name: 'code', required: true },
            { name: 'language', required: false },
          ],
        },
        (args) => {
          received = args
          return 'ok'
        },
      )
      const { client, close } = await createTestClient(mcp)
      try {
        await client.getPrompt({ name: 'review', arguments: { code: 'x = 1' } })
        expect(received).toEqual({ code: 'x = 1' })
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Content types
  // ---------------------------------------------------------------------------

  describe('content types', () => {
    it('handler can return an image content block', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const msg: PromptMessage = {
        role: 'user',
        content: { type: 'image', data: 'abc123', mimeType: 'image/png' },
      }
      mcp.prompt({ name: 'img', description: 'test' }, () => msg)
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.getPrompt({ name: 'img', arguments: {} })
        expect(result.messages[0].content).toMatchObject({ type: 'image', mimeType: 'image/png' })
      } finally {
        await close()
      }
    })

    it('handler can return an embedded resource content block', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const msg: PromptMessage = {
        role: 'user',
        content: {
          type: 'resource',
          resource: { uri: 'file://readme.md', mimeType: 'text/markdown', text: '# Hello' },
        },
      }
      mcp.prompt({ name: 'doc', description: 'test' }, () => msg)
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.getPrompt({ name: 'doc', arguments: {} })
        expect(result.messages[0].content).toMatchObject({
          type: 'resource',
          resource: { uri: 'file://readme.md' },
        })
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe('pagination', () => {
    it('prompts/list returns the first page and a nextCursor when results exceed the page size', async () => {
      const mcp = new FastMCP({ name: 'test', promptsPageSize: 2 })
      mcp.prompt({ name: 'a', description: 'test' }, () => 'a')
      mcp.prompt({ name: 'b', description: 'test' }, () => 'b')
      mcp.prompt({ name: 'c', description: 'test' }, () => 'c')
      const { client, close } = await createTestClient(mcp)
      try {
        const page1 = await client.listPrompts()
        expect(page1.prompts).toHaveLength(2)
        expect(page1.prompts.map((p) => p.name)).toEqual(['a', 'b'])
        expect(page1.nextCursor).toBeDefined()
      } finally {
        await close()
      }
    })

    it('supplying a cursor returns the next page of prompts', async () => {
      const mcp = new FastMCP({ name: 'test', promptsPageSize: 2 })
      mcp.prompt({ name: 'a', description: 'test' }, () => 'a')
      mcp.prompt({ name: 'b', description: 'test' }, () => 'b')
      mcp.prompt({ name: 'c', description: 'test' }, () => 'c')
      const { client, close } = await createTestClient(mcp)
      try {
        const page1 = await client.listPrompts()
        const page2 = await client.listPrompts({ cursor: page1.nextCursor })
        expect(page2.prompts).toHaveLength(1)
        expect(page2.prompts[0].name).toBe('c')
        expect(page2.nextCursor).toBeUndefined()
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  describe('visibility', () => {
    it('a disabled prompt does not appear in list responses', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'hidden', description: 'test', disabled: true }, () => 'secret')
      mcp.prompt({ name: 'visible', description: 'test' }, () => 'public')
      const { client, close } = await createTestClient(mcp)
      try {
        const { prompts } = await client.listPrompts()
        expect(prompts.map((p) => p.name)).toEqual(['visible'])
      } finally {
        await close()
      }
    })

    it('calling a disabled prompt returns an error', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'hidden', description: 'test', disabled: true }, () => 'secret')
      const { client, close } = await createTestClient(mcp)
      try {
        await expect(client.getPrompt({ name: 'hidden', arguments: {} })).rejects.toThrow()
      } finally {
        await close()
      }
    })

    it('clients are notified when the prompt list changes', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const { client, close } = await createTestClient(mcp)
      try {
        const notified = new Promise<void>((resolve) => {
          client.setNotificationHandler(PromptListChangedNotificationSchema, () => resolve())
        })
        mcp.prompt({ name: 'new', description: 'test' }, () => 'hi')
        await notified
      } finally {
        await close()
      }
    })
  })
})
