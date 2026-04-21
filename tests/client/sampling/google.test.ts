import { describe, it, expect, vi } from 'vitest'
import type { GoogleGenAI, GenerateContentResponse } from '@google/genai'
import { GoogleSamplingAdapter } from 'fastmcp-ts/client'
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

function makeChunk(overrides: Partial<GenerateContentResponse> = {}): GenerateContentResponse {
  return {
    text: 'hello back',
    functionCalls: undefined,
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'hello back' }] }, index: 0 }],
    ...overrides,
  } as unknown as GenerateContentResponse
}

async function* makeStream(chunks: GenerateContentResponse[]) {
  for (const chunk of chunks) yield chunk
}

function makeMockClient(chunks: GenerateContentResponse[]) {
  const generateContentStream = vi.fn().mockResolvedValue(makeStream(chunks))
  return {
    models: { generateContentStream },
    _generateContentStream: generateContentStream,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleSamplingAdapter', () => {
  describe('parameter translation', () => {
    it('maps maxTokens → config.maxOutputTokens', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      await adapter.asHandler()(makeParams({ maxTokens: 512 }))

      const call = mock._generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> }
      expect(call.config.maxOutputTokens).toBe(512)
    })

    it('maps systemPrompt → config.systemInstruction', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      await adapter.asHandler()(makeParams({ systemPrompt: 'be brief' }))

      const call = mock._generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> }
      expect(call.config.systemInstruction).toMatchObject({ parts: [{ text: 'be brief' }] })
    })

    it('uses first modelPreferences hint', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)

      await adapter.asHandler()(makeParams({ modelPreferences: { hints: [{ name: 'gemini-1.5-pro' }] } }))
      expect((mock._generateContentStream.mock.calls[0][0] as { model: string }).model).toBe('gemini-1.5-pro')
    })

    it('defaults to gemini-2.0-flash when no hint is provided', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)

      await adapter.asHandler()(makeParams())
      expect((mock._generateContentStream.mock.calls[0][0] as { model: string }).model).toBe('gemini-2.0-flash')
    })

    it('maps stopSequences → config.stopSequences', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      await adapter.asHandler()(makeParams({ stopSequences: ['END'] }))

      const call = mock._generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> }
      expect(call.config.stopSequences).toEqual(['END'])
    })
  })

  describe('tool translation', () => {
    it('strips title fields from tool inputSchema (MALFORMED_FUNCTION_CALL regression)', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      const tools = [{
        name: 'search',
        description: 'search the web',
        inputSchema: {
          type: 'object' as const,
          title: 'SearchInput',
          properties: {
            q: { type: 'string', title: 'Query', description: 'search query' },
          },
        },
      }]

      await adapter.asHandler()(makeParams({ tools }))

      const call = mock._generateContentStream.mock.calls[0][0] as {
        config: { tools: Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }> }
      }
      const params = call.config.tools[0].functionDeclarations[0].parameters
      expect(params.title).toBeUndefined()
      expect((params.properties as Record<string, { title?: unknown }>).q.title).toBeUndefined()
      // description should still be present
      expect((params.properties as Record<string, { description?: string }>).q.description).toBe('search query')
    })

    it('maps toolChoice "required" → mode: "ANY"', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      const tools = [{ name: 't', inputSchema: { type: 'object' as const, properties: {} } }]

      await adapter.asHandler()(makeParams({ tools, toolChoice: { mode: 'required' } }))

      const call = mock._generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> }
      expect(call.config.toolConfig).toMatchObject({ functionCallingConfig: { mode: 'ANY' } })
    })

    it('maps toolChoice "none" → mode: "NONE" and omits functionDeclarations', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      const tools = [{ name: 't', inputSchema: { type: 'object' as const, properties: {} } }]

      await adapter.asHandler()(makeParams({ tools, toolChoice: { mode: 'none' } }))

      const call = mock._generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> }
      expect(call.config.tools).toBeUndefined()
    })
  })

  describe('message translation', () => {
    it('maps MCP role "assistant" → Gemini role "model"', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)

      await adapter.asHandler()(makeParams({
        messages: [{ role: 'assistant', content: { type: 'text', text: 'sure' } }],
      }))

      const call = mock._generateContentStream.mock.calls[0][0] as { contents: Array<{ role: string }> }
      expect(call.contents[0].role).toBe('model')
    })

    it('converts tool_use → functionCall part', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)

      await adapter.asHandler()(makeParams({
        messages: [{
          role: 'assistant',
          content: { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'hi' } },
        }],
      }))

      const call = mock._generateContentStream.mock.calls[0][0] as {
        contents: Array<{ parts: Array<{ functionCall?: { name: string; args: unknown } }> }>
      }
      expect(call.contents[0].parts[0].functionCall).toMatchObject({ name: 'search', args: { q: 'hi' } })
    })

    it('converts tool_result → functionResponse, resolving name from prior tool_use', async () => {
      const mock = makeMockClient([makeChunk()])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)

      await adapter.asHandler()(makeParams({
        messages: [
          { role: 'assistant', content: { type: 'tool_use', id: 'tu1', name: 'search', input: {} } },
          {
            role: 'user',
            content: { type: 'tool_result', toolUseId: 'tu1', content: [{ type: 'text', text: 'result' }] },
          },
        ],
      }))

      const call = mock._generateContentStream.mock.calls[0][0] as {
        contents: Array<{ parts: Array<{ functionResponse?: { name: string } }> }>
      }
      const resultMsg = call.contents[1]
      expect(resultMsg.parts[0].functionResponse).toMatchObject({ name: 'search' })
    })
  })

  describe('response mapping', () => {
    it('maps text response to CreateMessageResult', async () => {
      const mock = makeMockClient([makeChunk({ text: 'hi back', functionCalls: undefined })])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({
        role: 'assistant',
        stopReason: 'endTurn',
        content: { type: 'text', text: 'hi back' },
      })
    })

    it('maps functionCalls response to CreateMessageResultWithTools', async () => {
      const mock = makeMockClient([makeChunk({
        text: undefined,
        functionCalls: [{ name: 'search', args: { q: 'test' }, id: 'fc1' }],
      })])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({
        stopReason: 'toolUse',
        content: [{ type: 'tool_use', name: 'search', input: { q: 'test' } }],
      })
    })

    it('maps MAX_TOKENS finish reason → maxTokens stop reason', async () => {
      const mock = makeMockClient([makeChunk({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: 'partial' }] }, index: 0 }],
      })])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI)
      const result = await adapter.asHandler()(makeParams())

      expect(result).toMatchObject({ stopReason: 'maxTokens' })
    })
  })

  describe('streaming', () => {
    it('fires onToken for text chunks', async () => {
      const tokens: string[] = []
      const mock = makeMockClient([
        makeChunk({ text: 'hel' }),
        makeChunk({ text: 'lo' }),
      ])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI, {
        onToken: (t) => tokens.push(t),
      })
      await adapter.asHandler()(makeParams())

      expect(tokens).toEqual(['hel', 'lo'])
    })

    it('does not fire onToken for empty/undefined text chunks', async () => {
      const tokens: string[] = []
      const mock = makeMockClient([
        makeChunk({ text: '' }),
        makeChunk({ text: 'ok' }),
      ])
      const adapter = new GoogleSamplingAdapter(mock as unknown as GoogleGenAI, {
        onToken: (t) => tokens.push(t),
      })
      await adapter.asHandler()(makeParams())

      expect(tokens).toEqual(['ok'])
    })
  })
})
