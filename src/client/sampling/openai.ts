import type OpenAI from 'openai'
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

type OAIMessage = OpenAI.Chat.ChatCompletionMessageParam

function toContentParts(
  content: SamplingMessage['content'],
): string | OpenAI.Chat.ChatCompletionContentPart[] {
  const items = Array.isArray(content) ? content : [content]
  // Collapse single text block to a plain string for simplicity
  if (items.length === 1 && items[0].type === 'text') return items[0].text

  return items.flatMap((block): OpenAI.Chat.ChatCompletionContentPart[] => {
    if (block.type === 'text') {
      return [{ type: 'text', text: block.text }]
    } else if (block.type === 'image') {
      return [{
        type: 'image_url',
        image_url: { url: `data:${block.mimeType};base64,${block.data}` },
      }]
    }
    return []
  })
}

function toOpenAIMessages(
  messages: SamplingMessage[],
  systemPrompt: string | undefined,
): OAIMessage[] {
  const out: OAIMessage[] = []

  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt })
  }

  for (const m of messages) {
    const items = Array.isArray(m.content) ? m.content : [m.content]

    // tool_use blocks → assistant message with tool_calls
    const toolUseItems = items.filter((b) => b.type === 'tool_use')
    if (toolUseItems.length > 0) {
      out.push({
        role: 'assistant',
        tool_calls: toolUseItems.map((b) => {
          if (b.type !== 'tool_use') throw new Error('unreachable')
          return {
            id: b.id,
            type: 'function' as const,
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }
        }),
      })
      continue
    }

    // tool_result blocks → tool messages
    const toolResultItems = items.filter((b) => b.type === 'tool_result')
    if (toolResultItems.length > 0) {
      for (const b of toolResultItems) {
        if (b.type !== 'tool_result') continue
        const text = b.content
          .filter((c) => c.type === 'text')
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n')
        out.push({ role: 'tool', tool_call_id: b.toolUseId, content: text })
      }
      continue
    }

    const role = m.role as 'user' | 'assistant'
    const content = toContentParts(m.content)
    if (role === 'user') {
      out.push({ role, content: content as OpenAI.Chat.ChatCompletionUserMessageParam['content'] })
    } else {
      out.push({ role, content: typeof content === 'string' ? content : '' })
    }
  }

  return out
}

function toOpenAITools(tools: Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.inputSchema as OpenAI.FunctionParameters,
    },
  }))
}

function toOpenAIToolChoice(
  choice: ToolChoice | undefined,
): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined
  if (choice.mode === 'required') return 'required'
  if (choice.mode === 'none') return 'none'
  return 'auto'
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string | null | undefined): string {
  if (reason === 'stop') return 'endTurn'
  if (reason === 'length') return 'maxTokens'
  if (reason === 'tool_calls') return 'toolUse'
  return 'endTurn'
}

function buildResult(completion: OpenAI.Chat.ChatCompletion): AnySamplingResult {
  const choice = completion.choices[0]
  const stopReason = mapFinishReason(choice?.finish_reason)
  const model = completion.model

  if (stopReason === 'toolUse') {
    const calls = choice.message.tool_calls ?? []
    const content: ToolUseContent[] = calls.flatMap((tc) => {
      // tc is ChatCompletionMessageToolCall (union); filter to function type
      if (tc.type !== 'function') return []
      const fn = (tc as { type: 'function'; id: string; function: { name: string; arguments: string } }).function
      return [{
        type: 'tool_use' as const,
        id: tc.id,
        name: fn.name,
        input: JSON.parse(fn.arguments) as Record<string, unknown>,
      }]
    })
    return { role: 'assistant', model, stopReason, content }
  }

  const text = choice.message.content ?? ''
  return { role: 'assistant', model, stopReason, content: { type: 'text', text } }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAISamplingAdapter implements SamplingAdapter {
  private readonly _client: OpenAI
  private readonly _options: SamplingAdapterOptions & { defaultModel?: string }

  constructor(
    client: OpenAI,
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
        this._options.defaultModel ?? 'gpt-4o',
      )

      const omitTools = params.toolChoice?.mode === 'none'
      const tools = !omitTools && params.tools?.length
        ? toOpenAITools(params.tools)
        : undefined
      const toolChoice = tools ? toOpenAIToolChoice(params.toolChoice) : undefined
      const onToken = this._options.onToken

      const stream = this._client.chat.completions.stream({
        model,
        messages: toOpenAIMessages(params.messages, params.systemPrompt),
        max_completion_tokens: params.maxTokens ?? 1024,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.stopSequences?.length ? { stop: params.stopSequences } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      })

      if (onToken) {
        stream.on('content', (delta) => { onToken(delta) })
      }

      const completion = await stream.finalChatCompletion()
      return buildResult(completion)
    }
  }
}
