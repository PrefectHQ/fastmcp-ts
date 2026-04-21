import { describe, it, expect, vi } from 'vitest'
import type OpenAI from 'openai'
import { OpenAISamplingAdapter } from 'fastmcp-ts/client'
import type { CreateMessageRequestParams } from 'fastmcp-ts/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<CreateMessageRequestParams> = {}): CreateMessageRequestParams {
  return {
    messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
    maxTokens: 256,
    ...overrides,
  }
}

function makeCompletion(
  overrides: Partial<OpenAI.Chat.ChatCompletion> = {},
): OpenAI.Chat.ChatCompletion {
  return {
    id: 'cmpl_test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-test',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'hi back', refusal: null },
      finish_reason: 'stop',
      logprobs: null,
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    ...overrides,
  } as OpenAI.Chat.ChatCompletion
}

function makeMockClient(completion: OpenAI.Chat.ChatCompletion) {
  const finalChatCompletion = vi.fn().mockResolvedValue(completion)
  const on = vi.fn().mockReturnThis()
  const stream = vi.fn().mockReturnValue({ finalChatCompletion, on })
  return {
    chat: { completions: { stream } },
    _stream: stream,
    _finalChatCompletion: finalChatCompletion,
    _on: on,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAISamplingAdapter', () => {
  describe('parameter translation', () => {
    it('uses max_completion_tokens (not max_tokens) — regression guard', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      await adapter.asHandler()(makeParams({ maxTokens: 512 }))

      const call = mock.chat.completions.stream.mock.calls[0][0] as Record<string, unknown>
      expect(call.max_completion_tokens).toBe(512)
      expect(call.max_tokens).toBeUndefined()
    })

    it('injects systemPrompt as first message with role "system"', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      await adapter.asHandler()(makeParams({ systemPrompt: 'be brief' }))

      const call = mock.chat.completions.stream.mock.calls[0][0] as { messages: unknown[] }
      expect(call.messages[0]).toMatchObject({ role: 'system', content: 'be brief' })
    })

    it('uses first modelPreferences hint as model; defaults to gpt-4o', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      const handler = adapter.asHandler()

      await handler(makeParams({ modelPreferences: { hints: [{ name: 'gpt-4-turbo' }] } }))
      expect((mock.chat.completions.stream.mock.calls[0][0] as { model: string }).model).toBe('gpt-4-turbo')

      vi.clearAllMocks()
      await handler(makeParams())
      expect((mock.chat.completions.stream.mock.calls[0][0] as { model: string }).model).toBe('gpt-4o')
    })

    it('passes stopSequences → stop', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      await adapter.asHandler()(makeParams({ stopSequences: ['<|end|>'] }))

      expect(mock.chat.completions.stream).toHaveBeenCalledWith(
        expect.objectContaining({ stop: ['<|end|>'] }),
      )
    })
  })

  describe('message translation', () => {
    it('converts image content to image_url with data URI', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      await adapter.asHandler()(makeParams({
        messages: [{
          role: 'user',
          content: { type: 'image', data: 'abc123', mimeType: 'image/jpeg' },
        }],
      }))

      const call = mock.chat.completions.stream.mock.calls[0][0] as { messages: unknown[] }
      expect(call.messages[0]).toMatchObject({
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } }],
      })
    })

    it('converts tool_use → assistant message with tool_calls', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      await adapter.asHandler()(makeParams({
        messages: [{
          role: 'assistant',
          content: { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'hi' } },
        }],
      }))

      const call = mock.chat.completions.stream.mock.calls[0][0] as { messages: unknown[] }
      expect(call.messages[0]).toMatchObject({
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"hi"}' } }],
      })
    })

    it('converts tool_result → tool message with tool_call_id', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      await adapter.asHandler()(makeParams({
        messages: [{
          role: 'user',
          content: {
            type: 'tool_result',
            toolUseId: 'call_1',
            content: [{ type: 'text', text: 'result text' }],
          },
        }],
      }))

      const call = mock.chat.completions.stream.mock.calls[0][0] as { messages: unknown[] }
      expect(call.messages[0]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'result text',
      })
    })
  })

  describe('tool translation', () => {
    it('converts MCP tools to OpenAI function tools', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      const tools = [{
        name: 'add',
        description: 'adds numbers',
        inputSchema: { type: 'object' as const, properties: { a: { type: 'number' } }, required: ['a'] },
      }]

      await adapter.asHandler()(makeParams({ tools }))

      expect(mock.chat.completions.stream).toHaveBeenCalledWith(expect.objectContaining({
        tools: [{ type: 'function', function: { name: 'add', description: 'adds numbers', parameters: tools[0].inputSchema } }],
      }))
    })

    it('maps toolChoice "required" → "required"', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      const tools = [{ name: 't', inputSchema: { type: 'object' as const, properties: {} } }]

      await adapter.asHandler()(makeParams({ tools, toolChoice: { mode: 'required' } }))

      expect(mock.chat.completions.stream).toHaveBeenCalledWith(
        expect.objectContaining({ tool_choice: 'required' }),
      )
    })

    it('omits tools when toolChoice.mode is "none"', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      const tools = [{ name: 't', inputSchema: { type: 'object' as const, properties: {} } }]

      await adapter.asHandler()(makeParams({ tools, toolChoice: { mode: 'none' } }))

      const call = mock.chat.completions.stream.mock.calls[0][0] as Record<string, unknown>
      expect(call.tools).toBeUndefined()
    })
  })

  describe('response mapping', () => {
    it('maps finish_reason stop → endTurn with text content', async () => {
      const mock = makeMockClient(makeCompletion())
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({
        role: 'assistant',
        stopReason: 'endTurn',
        content: { type: 'text', text: 'hi back' },
      })
    })

    it('maps finish_reason tool_calls → toolUse with ToolUseContent array', async () => {
      const mock = makeMockClient(makeCompletion({
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"test"}' },
            }],
          },
        }],
      }))
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({
        stopReason: 'toolUse',
        content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } }],
      })
    })

    it('handles multiple parallel tool calls in one response', async () => {
      const mock = makeMockClient(makeCompletion({
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'b', arguments: '{"x":1}' } },
            ],
          },
        }],
      }))
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      const result = await adapter.asHandler()(makeParams())

      expect((result as { content: unknown[] }).content).toHaveLength(2)
      expect(result).toMatchObject({
        content: [
          { type: 'tool_use', id: 'c1', name: 'a' },
          { type: 'tool_use', id: 'c2', name: 'b', input: { x: 1 } },
        ],
      })
    })

    it('maps finish_reason length → maxTokens', async () => {
      const mock = makeMockClient(makeCompletion({
        choices: [{ index: 0, finish_reason: 'length', logprobs: null, message: { role: 'assistant', content: 'truncated', refusal: null } }],
      }))
      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({ stopReason: 'maxTokens' })
    })
  })

  describe('streaming', () => {
    it('fires onToken for content delta events', async () => {
      const tokens: string[] = []
      const mock = makeMockClient(makeCompletion())

      mock._on.mockImplementation((event: string, cb: (delta: string) => void) => {
        if (event === 'content') {
          cb('hello ')
          cb('world')
        }
        return { finalChatCompletion: mock._finalChatCompletion, on: mock._on }
      })

      const adapter = new OpenAISamplingAdapter(mock as unknown as OpenAI, {
        onToken: (t) => tokens.push(t),
      })
      await adapter.asHandler()(makeParams())

      expect(tokens).toEqual(['hello ', 'world'])
    })
  })
})
