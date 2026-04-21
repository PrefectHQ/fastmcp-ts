import type {
  SamplingMessage,
  Tool,
  ToolChoice,
} from '@modelcontextprotocol/sdk/types'
import type { AnySamplingResult } from '../results.js'
import type { SamplingAdapter, SamplingAdapterOptions, ModelSelector, OnTokenCallback } from './types.js'
import type { SamplingHandler } from '../handlers.js'
import { resolveModel } from './types.js'
import type { CreateMessageRequestParams } from '@modelcontextprotocol/sdk/types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenericCompletionParams {
  model: string
  messages: SamplingMessage[]
  system?: string
  /** Defaulted to 1024 when absent in the original request. */
  maxTokens: number
  temperature?: number
  stopSequences?: string[]
  tools?: Tool[]
  toolChoice?: ToolChoice
  onToken?: OnTokenCallback
}

export type GenericCompletionFn = (
  params: GenericCompletionParams,
) => Promise<AnySamplingResult>

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Contribution template. Wraps any async function into a SamplingHandler.
 *
 * The adapter resolves the model from modelPreferences, defaults maxTokens,
 * and threads onToken through. Message format conversion, tool translation,
 * and streaming are the caller's responsibility.
 *
 * Example:
 * ```ts
 * const adapter = new GenericSamplingAdapter(async ({ model, messages }) => {
 *   const text = await myLlm.complete(model, messages)
 *   return { role: 'assistant', content: { type: 'text', text }, model, stopReason: 'endTurn' }
 * })
 * ```
 */
export class GenericSamplingAdapter implements SamplingAdapter {
  private readonly _fn: GenericCompletionFn
  private readonly _options: SamplingAdapterOptions & { defaultModel?: string }

  constructor(
    fn: GenericCompletionFn,
    options?: SamplingAdapterOptions & { defaultModel?: string },
  ) {
    this._fn = fn
    this._options = options ?? {}
  }

  asHandler(): SamplingHandler {
    return async (params: CreateMessageRequestParams): Promise<AnySamplingResult> => {
      const model = resolveModel(
        params.modelPreferences,
        this._options.modelSelector,
        this._options.defaultModel ?? 'unknown',
      )
      return this._fn({
        model,
        messages: params.messages,
        system: params.systemPrompt,
        maxTokens: params.maxTokens ?? 1024,
        temperature: params.temperature,
        stopSequences: params.stopSequences,
        tools: params.tools,
        toolChoice: params.toolChoice,
        onToken: this._options.onToken,
      })
    }
  }
}
