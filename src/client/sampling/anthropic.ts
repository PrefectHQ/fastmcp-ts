import type Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
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
// Message translation
// ---------------------------------------------------------------------------

function toBlocks(content: SamplingMessage['content']): ContentBlockParam[] {
  const items = Array.isArray(content) ? content : [content]
  const out: ContentBlockParam[] = []

  for (const block of items) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType as Anthropic.Base64ImageSource['media_type'],
          data: block.data,
        },
      })
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      })
    } else if (block.type === 'tool_result') {
      const resultContent: ToolResultBlockParam['content'] = block.content.flatMap((c) =>
        c.type === 'text' ? [{ type: 'text' as const, text: c.text }] : [],
      )
      out.push({
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: resultContent,
        is_error: block.isError,
      })
    }
    // audio: not supported by Anthropic messages API — skip
  }
  return out
}

function toAnthropicMessages(messages: SamplingMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: toBlocks(m.content),
  }))
}

function toAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }))
}

function toAnthropicToolChoice(
  choice: ToolChoice | undefined,
): Anthropic.MessageCreateParams['tool_choice'] {
  if (!choice) return undefined
  if (choice.mode === 'required') return { type: 'any' }
  return { type: 'auto' }
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | null | undefined): string {
  if (reason === 'end_turn') return 'endTurn'
  if (reason === 'stop_sequence') return 'stopSequence'
  if (reason === 'max_tokens') return 'maxTokens'
  if (reason === 'tool_use') return 'toolUse'
  return reason ?? 'endTurn'
}

function buildResult(message: Anthropic.Message): AnySamplingResult {
  const stopReason = mapStopReason(message.stop_reason)

  if (stopReason === 'toolUse') {
    const content = message.content.flatMap((block): ToolUseContent[] => {
      if (block.type === 'tool_use') {
        return [{
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        }]
      }
      return []
    })
    return { role: 'assistant', model: message.model, stopReason, content }
  }

  const textBlock = message.content.find((b) => b.type === 'text')
  const text = textBlock?.type === 'text' ? textBlock.text : ''
  return { role: 'assistant', model: message.model, stopReason, content: { type: 'text', text } }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AnthropicSamplingAdapter implements SamplingAdapter {
  private readonly _client: Anthropic
  private readonly _options: SamplingAdapterOptions & { defaultModel?: string }

  constructor(
    client: Anthropic,
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
        this._options.defaultModel ?? 'claude-opus-4-5',
      )

      const omitTools = params.toolChoice?.mode === 'none'
      const tools = !omitTools && params.tools?.length
        ? toAnthropicTools(params.tools)
        : undefined
      const toolChoice = tools ? toAnthropicToolChoice(params.toolChoice) : undefined
      const onToken = this._options.onToken

      const stream = this._client.messages.stream({
        model,
        messages: toAnthropicMessages(params.messages),
        max_tokens: params.maxTokens ?? 1024,
        ...(params.systemPrompt !== undefined ? { system: params.systemPrompt } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.stopSequences?.length ? { stop_sequences: params.stopSequences } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      })

      if (onToken) {
        stream.on('text', (text) => { onToken(text) })
      }

      const message = await stream.finalMessage()
      return buildResult(message)
    }
  }
}
