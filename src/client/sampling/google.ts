import type { GoogleGenAI } from '@google/genai'
import type {
  GenerateContentConfig,
  GenerateContentResponse,
} from '@google/genai'
import type {
  CreateMessageRequestParams,
  SamplingMessage,
  Tool,
  ToolChoice,
  ToolUseContent,
} from '@modelcontextprotocol/sdk/types.js'
import type { AnySamplingResult } from '../results.js'
import type { SamplingHandler } from '../handlers.js'
import type { SamplingAdapter, SamplingAdapterOptions } from './types.js'
import { resolveModel } from './types.js'

// ---------------------------------------------------------------------------
// Title pruning
// ---------------------------------------------------------------------------

/**
 * Removes 'title' from all property definitions in a JSON Schema object.
 * Gemini emits MALFORMED_FUNCTION_CALL when property titles are present.
 */
function pruneTitle(schema: Record<string, unknown>): Record<string, unknown> {
  const { title: _dropped, ...rest } = schema
  if (rest.properties && typeof rest.properties === 'object') {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        pruneTitle(v as Record<string, unknown>),
      ]),
    )
  }
  return rest
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

function toGeminiRole(role: 'user' | 'assistant'): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user'
}

/** Build an id→name map from prior tool_use blocks so tool_result can reference by name. */
function buildToolNameMap(messages: SamplingMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of messages) {
    const items = Array.isArray(m.content) ? m.content : [m.content]
    for (const b of items) {
      if (b.type === 'tool_use') map.set(b.id, b.name)
    }
  }
  return map
}

function toGeminiContents(
  messages: SamplingMessage[],
  toolNameById: Map<string, string>,
): object[] {
  return messages.map((m) => {
    const items = Array.isArray(m.content) ? m.content : [m.content]
    const parts = items.flatMap((block): object[] => {
      if (block.type === 'text') {
        return [{ text: block.text }]
      } else if (block.type === 'image') {
        return [{ inlineData: { data: block.data, mimeType: block.mimeType } }]
      } else if (block.type === 'tool_use') {
        return [{ functionCall: { name: block.name, args: block.input } }]
      } else if (block.type === 'tool_result') {
        const name = toolNameById.get(block.toolUseId) ?? block.toolUseId
        const text = block.content
          .filter((c) => c.type === 'text')
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n')
        return [{ functionResponse: { name, response: { content: text } } }]
      }
      return []
    })
    return { role: toGeminiRole(m.role as 'user' | 'assistant'), parts }
  })
}

function toGeminiFunctionDeclarations(tools: Tool[]): object[] {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: pruneTitle(t.inputSchema as Record<string, unknown>),
  }))
}

function toGeminiToolConfig(choice: ToolChoice | undefined): object | undefined {
  if (!choice) return undefined
  const mode =
    choice.mode === 'required' ? 'ANY' :
    choice.mode === 'none' ? 'NONE' :
    'AUTO'
  return { functionCallingConfig: { mode } }
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

function buildResult(response: GenerateContentResponse, model: string): AnySamplingResult {
  const functionCalls = response.functionCalls

  if (functionCalls?.length) {
    const content: ToolUseContent[] = functionCalls.map((fc, i) => ({
      type: 'tool_use' as const,
      id: fc.id ?? `tool-${i}`,
      name: fc.name ?? '',
      input: (fc.args ?? {}) as Record<string, unknown>,
    }))
    return { role: 'assistant', model, stopReason: 'toolUse', content }
  }

  const candidate = response.candidates?.[0]
  const finishReason = candidate?.finishReason
  const stopReason =
    finishReason === 'MAX_TOKENS' ? 'maxTokens' :
    'endTurn'

  const text = response.text ?? ''
  return { role: 'assistant', model, stopReason, content: { type: 'text', text } }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GoogleSamplingAdapter implements SamplingAdapter {
  private readonly _client: GoogleGenAI
  private readonly _options: SamplingAdapterOptions & { defaultModel?: string }

  constructor(
    client: GoogleGenAI,
    options?: SamplingAdapterOptions & { defaultModel?: string },
  ) {
    this._client = client
    this._options = options ?? {}
  }

  asHandler(): SamplingHandler {
    return async (params: CreateMessageRequestParams): Promise<AnySamplingResult> => {
      const model = resolveModel(
        params.modelPreferences,
        this._options.modelSelector,
        this._options.defaultModel ?? 'gemini-2.0-flash',
      )

      const toolNameById = buildToolNameMap(params.messages)
      const contents = toGeminiContents(params.messages, toolNameById)
      const onToken = this._options.onToken

      const omitTools = params.toolChoice?.mode === 'none'
      const functionDeclarations = !omitTools && params.tools?.length
        ? toGeminiFunctionDeclarations(params.tools)
        : undefined
      const toolConfig = !omitTools ? toGeminiToolConfig(params.toolChoice) : undefined

      const config: GenerateContentConfig = {
        maxOutputTokens: params.maxTokens ?? 1024,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.stopSequences?.length ? { stopSequences: params.stopSequences } : {}),
        ...(params.systemPrompt
          ? { systemInstruction: { parts: [{ text: params.systemPrompt }] } }
          : {}),
        ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      }

      const stream = await this._client.models.generateContentStream({
        model,
        contents: contents as Parameters<typeof this._client.models.generateContentStream>[0]['contents'],
        config,
      })

      let lastChunk: GenerateContentResponse | undefined
      for await (const chunk of stream) {
        lastChunk = chunk
        if (onToken) {
          const text = chunk.text
          if (text) onToken(text)
        }
      }

      return buildResult(lastChunk!, model)
    }
  }
}
