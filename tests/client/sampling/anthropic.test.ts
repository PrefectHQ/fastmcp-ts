import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { AnthropicSamplingAdapter } from 'fastmcp-ts/client'
import type { CreateMessageRequestParams } from 'fastmcp-ts/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<CreateMessageRequestParams> = {}): CreateMessageRequestParams {
  return {
    messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
    maxTokens: 256,
    ...overrides,
  }
}

/** Minimal Anthropic.Message with the fields the adapter reads. */
function makeAnthropicMessage(
  overrides: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: 'hello back' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  } as Anthropic.Message
}

function makeMockClient(message: Anthropic.Message) {
  const finalMessage = vi.fn().mockResolvedValue(message)
  const on = vi.fn().mockReturnThis()
  const stream = vi.fn().mockReturnValue({ finalMessage, on })
  return {
    messages: { stream },
    _stream: stream,
    _finalMessage: finalMessage,
    _on: on,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicSamplingAdapter', () => {
  describe('parameter translation', () => {
    it('maps systemPrompt → system', async () => {
      const msg = makeAnthropicMessage()
      const mock = makeMockClient(msg)
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      const handler = adapter.asHandler()

      await handler(makeParams({ systemPrompt: 'be terse' }))

      expect(mock.messages.stream).toHaveBeenCalledWith(
        expect.objectContaining({ system: 'be terse' }),
      )
    })

    it('maps maxTokens → max_tokens', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      await adapter.asHandler()(makeParams({ maxTokens: 512 }))

      expect(mock.messages.stream).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 512 }),
      )
    })

    it('uses first modelPreferences hint as model; defaults to claude-opus-4-5', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      const handler = adapter.asHandler()

      await handler(makeParams({ modelPreferences: { hints: [{ name: 'claude-3-5-haiku' }] } }))
      expect(mock.messages.stream).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3-5-haiku' }),
      )

      vi.clearAllMocks()
      await handler(makeParams())
      expect(mock.messages.stream).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-5' }),
      )
    })

    it('passes stopSequences → stop_sequences', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      await adapter.asHandler()(makeParams({ stopSequences: ['STOP', 'END'] }))

      expect(mock.messages.stream).toHaveBeenCalledWith(
        expect.objectContaining({ stop_sequences: ['STOP', 'END'] }),
      )
    })
  })

  describe('tool translation', () => {
    it('converts MCP tools to Anthropic tool schema (inputSchema → input_schema)', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      const tools = [{
        name: 'add',
        description: 'adds two numbers',
        inputSchema: { type: 'object' as const, properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      }]

      await adapter.asHandler()(makeParams({ tools }))

      expect(mock.messages.stream).toHaveBeenCalledWith(expect.objectContaining({
        tools: [expect.objectContaining({ name: 'add', input_schema: tools[0].inputSchema })],
      }))
    })

    it('omits tools entirely when toolChoice.mode is "none"', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      const tools = [{ name: 't', inputSchema: { type: 'object' as const, properties: {} } }]

      await adapter.asHandler()(makeParams({ tools, toolChoice: { mode: 'none' } }))

      const call = mock.messages.stream.mock.calls[0][0] as Record<string, unknown>
      expect(call.tools).toBeUndefined()
    })

    it('maps toolChoice "required" → Anthropic { type: "any" }', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      const tools = [{ name: 't', inputSchema: { type: 'object' as const, properties: {} } }]

      await adapter.asHandler()(makeParams({ tools, toolChoice: { mode: 'required' } }))

      expect(mock.messages.stream).toHaveBeenCalledWith(
        expect.objectContaining({ tool_choice: { type: 'any' } }),
      )
    })
  })

  describe('message translation', () => {
    it('converts image content to base64 source block', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)

      await adapter.asHandler()(makeParams({
        messages: [{
          role: 'user',
          content: { type: 'image', data: 'abc123', mimeType: 'image/png' },
        }],
      }))

      const sentMessages = (mock.messages.stream.mock.calls[0][0] as { messages: unknown[] }).messages
      expect(sentMessages[0]).toMatchObject({
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }],
      })
    })

    it('converts tool_use block for assistant messages', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)

      await adapter.asHandler()(makeParams({
        messages: [{
          role: 'assistant',
          content: { type: 'tool_use', id: 'tu1', name: 'ping', input: { x: 1 } },
        }],
      }))

      const sent = (mock.messages.stream.mock.calls[0][0] as { messages: unknown[] }).messages
      expect(sent[0]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'ping', input: { x: 1 } }],
      })
    })

    it('converts tool_result block with correct tool_use_id', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)

      await adapter.asHandler()(makeParams({
        messages: [{
          role: 'user',
          content: {
            type: 'tool_result',
            toolUseId: 'tu1',
            content: [{ type: 'text', text: '42' }],
          },
        }],
      }))

      const sent = (mock.messages.stream.mock.calls[0][0] as { messages: unknown[] }).messages
      expect(sent[0]).toMatchObject({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '42' }] }],
      })
    })
  })

  describe('response mapping', () => {
    it('maps end_turn → CreateMessageResult with text content', async () => {
      const mock = makeMockClient(makeAnthropicMessage({
        content: [{ type: 'text', text: 'hello back' }],
        stop_reason: 'end_turn',
        model: 'claude-test',
      }))
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({
        role: 'assistant',
        model: 'claude-test',
        stopReason: 'endTurn',
        content: { type: 'text', text: 'hello back' },
      })
    })

    it('maps tool_use → CreateMessageResultWithTools with ToolUseContent array', async () => {
      const mock = makeMockClient(makeAnthropicMessage({
        content: [{ type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'test' } }],
        stop_reason: 'tool_use',
        model: 'claude-test',
      }))
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({
        stopReason: 'toolUse',
        content: [{ type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'test' } }],
      })
    })

    it('maps max_tokens → maxTokens stop reason', async () => {
      const mock = makeMockClient(makeAnthropicMessage({ stop_reason: 'max_tokens' }))
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({ stopReason: 'maxTokens' })
    })
  })

  describe('streaming', () => {
    it('fires onToken for text events, not for other events', async () => {
      const tokens: string[] = []
      const mock = makeMockClient(makeAnthropicMessage())

      // Simulate stream.on('text', cb) calling the callback
      mock._on.mockImplementation((event: string, cb: (t: string) => void) => {
        if (event === 'text') {
          cb('hello ')
          cb('world')
        }
        return { finalMessage: mock._finalMessage, on: mock._on }
      })

      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic, {
        onToken: (t) => tokens.push(t),
      })
      await adapter.asHandler()(makeParams())

      expect(tokens).toEqual(['hello ', 'world'])
    })

    it('does not register text listener when onToken is absent', async () => {
      const mock = makeMockClient(makeAnthropicMessage())
      const adapter = new AnthropicSamplingAdapter(mock as unknown as Anthropic)
      await adapter.asHandler()(makeParams())

      expect(mock._on).not.toHaveBeenCalled()
    })
  })
})
