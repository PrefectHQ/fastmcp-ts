import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod/v4'
import { FastMCP } from 'fastmcp-ts/server'
import { Client } from 'fastmcp-ts/client'
import { GenericSamplingAdapter } from 'fastmcp-ts/client'
import type { GenericCompletionFn } from 'fastmcp-ts/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextResult(text = 'ok', model = 'test-model') {
  return {
    role: 'assistant' as const,
    content: { type: 'text' as const, text },
    model,
    stopReason: 'endTurn',
  }
}

// End-to-end: real in-process server, real Client, GenericSamplingAdapter stub
async function withSamplingServer(
  fn: GenericCompletionFn,
  test: (client: Client) => Promise<void>,
) {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  mcp.tool({ name: 'sampler', description: 'calls sampling', input: z.object({}) }, async () => {
    await mcp.getContext().sample({
      messages: [{ role: 'user', content: { type: 'text', text: 'ping' } }],
    })
    return 'done'
  })

  const adapter = new GenericSamplingAdapter(fn)
  const client = await Client.connect(mcp, { handlers: { sampling: adapter.asHandler() } })
  try {
    await test(client)
  } finally {
    await client.close()
  }
}

// ---------------------------------------------------------------------------
// Unit tests — params normalization
// ---------------------------------------------------------------------------

describe('GenericSamplingAdapter', () => {
  describe('model resolution', () => {
    it('uses first modelPreferences hint when no modelSelector is set', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult())
      const adapter = new GenericSamplingAdapter(fn)
      const handler = adapter.asHandler()

      await handler({
        messages: [],
        maxTokens: 512,
        modelPreferences: { hints: [{ name: 'my-model' }, { name: 'fallback' }] },
      })

      expect(fn.mock.calls[0][0].model).toBe('my-model')
    })

    it('falls back to defaultModel when hints are absent', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult())
      const adapter = new GenericSamplingAdapter(fn, { defaultModel: 'the-default' })
      const handler = adapter.asHandler()

      await handler({ messages: [], maxTokens: 512 })

      expect(fn.mock.calls[0][0].model).toBe('the-default')
    })

    it('uses modelSelector string unconditionally', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult())
      const adapter = new GenericSamplingAdapter(fn, { modelSelector: 'pinned-model' })
      const handler = adapter.asHandler()

      await handler({
        messages: [],
        maxTokens: 512,
        modelPreferences: { hints: [{ name: 'ignored' }] },
      })

      expect(fn.mock.calls[0][0].model).toBe('pinned-model')
    })

    it('calls modelSelector function with modelPreferences', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult())
      const selector = vi.fn().mockReturnValue('selected-model')
      const adapter = new GenericSamplingAdapter(fn, { modelSelector: selector })
      const handler = adapter.asHandler()

      const prefs = { hints: [{ name: 'a' }] }
      await handler({ messages: [], maxTokens: 512, modelPreferences: prefs })

      expect(selector).toHaveBeenCalledWith(prefs)
      expect(fn.mock.calls[0][0].model).toBe('selected-model')
    })
  })

  describe('param normalization', () => {
    it('defaults maxTokens to 1024 when absent', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult())
      const handler = new GenericSamplingAdapter(fn).asHandler()

      // maxTokens is required in the MCP schema but may be 0 — treat missing as default
      await handler({ messages: [], maxTokens: undefined as unknown as number })

      expect(fn.mock.calls[0][0].maxTokens).toBe(1024)
    })

    it('passes systemPrompt through as system', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult())
      const handler = new GenericSamplingAdapter(fn).asHandler()

      await handler({ messages: [], maxTokens: 100, systemPrompt: 'be helpful' })

      expect(fn.mock.calls[0][0].system).toBe('be helpful')
    })

    it('forwards tools and toolChoice verbatim', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult())
      const handler = new GenericSamplingAdapter(fn).asHandler()
      const tools = [{ name: 'ping', inputSchema: { type: 'object' as const, properties: {} } }]
      const toolChoice = { mode: 'required' as const }

      await handler({ messages: [], maxTokens: 100, tools, toolChoice })

      expect(fn.mock.calls[0][0].tools).toBe(tools)
      expect(fn.mock.calls[0][0].toolChoice).toBe(toolChoice)
    })

    it('threads onToken to the fn params', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult())
      const onToken = vi.fn()
      const handler = new GenericSamplingAdapter(fn, { onToken }).asHandler()

      await handler({ messages: [], maxTokens: 100 })

      expect(fn.mock.calls[0][0].onToken).toBe(onToken)
    })

    it('returns stopReason:toolUse result unchanged when fn returns it', async () => {
      const toolResult = {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'x', name: 'ping', input: {} }],
        model: 'test',
        stopReason: 'toolUse',
      }
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(toolResult)
      const handler = new GenericSamplingAdapter(fn).asHandler()

      const result = await handler({ messages: [], maxTokens: 100 })

      expect(result).toEqual(toolResult)
    })
  })

  describe('end-to-end round-trip', () => {
    it('sampling request from server reaches the adapter and result returns to tool', async () => {
      const fn = vi.fn<GenericCompletionFn>().mockResolvedValue(makeTextResult('pong'))

      await withSamplingServer(fn, async (client) => {
        await client.callTool('sampler', {})
        expect(fn).toHaveBeenCalledOnce()
        const params = fn.mock.calls[0][0]
        expect(params.messages[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'ping' } })
      })
    })
  })
})
