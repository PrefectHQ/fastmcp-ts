import type { AuthCheck } from './auth/authorization'

export interface PromptArgument {
  name: string
  description?: string
  /** When true, the client must supply this argument. Defaults to false. */
  required?: boolean
}

export interface PromptConfig {
  /** Unique prompt identifier. Inferred from the handler function name when omitted. */
  name?: string
  /** Human-readable display name shown in UIs. */
  title?: string
  /** Description shown to clients and LLMs. Inferred from name when omitted. */
  description?: string
  /** Declared arguments. Advertised to clients in prompts/list. */
  arguments?: PromptArgument[]
  /** When true the prompt is hidden from list responses and cannot be invoked. */
  disabled?: boolean
  /** Execution timeout in milliseconds. No timeout by default. */
  timeout?: number
  /** Arbitrary tags for server-side filtering and transforms. */
  tags?: string[]
  auth?: AuthCheck
}

// ---------------------------------------------------------------------------
// Content and message types
// ---------------------------------------------------------------------------

export type TextContent = { type: 'text'; text: string }
export type ImageContent = { type: 'image'; data: string; mimeType: string }
export type AudioContent = { type: 'audio'; data: string; mimeType: string }
export type ResourceLinkContent = {
  type: 'resource_link'
  uri: string
  name?: string
  description?: string
  mimeType?: string
}
export type EmbeddedResource = {
  type: 'resource'
  resource: { uri: string; mimeType?: string } & ({ text: string } | { blob: string })
}

export type PromptContent = TextContent | ImageContent | AudioContent | EmbeddedResource | ResourceLinkContent

export interface PromptMessage {
  role: 'user' | 'assistant'
  content: PromptContent
}

/**
 * Escape hatch for full control over the prompt response.
 * Return this from a prompt handler to set an explicit description and/or
 * supply a custom multi-turn message sequence.
 */
export class PromptResult {
  constructor(
    readonly messages: PromptMessage[],
    readonly description?: string,
  ) {}
}

// ---------------------------------------------------------------------------
// Return value conversion
// ---------------------------------------------------------------------------

function isPromptMessage(value: unknown): value is PromptMessage {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.role !== 'user' && v.role !== 'assistant') return false
  if (!v.content || typeof v.content !== 'object') return false
  return typeof (v.content as Record<string, unknown>).type === 'string'
}

/**
 * Converts a prompt handler's return value into the MCP GetPromptResult shape.
 *
 * - string          → single user text message
 * - PromptMessage   → wrapped in a one-element array
 * - PromptMessage[] → used as-is
 * - PromptResult    → passthrough (escape hatch)
 */
export function convertPromptResult(value: unknown): { description?: string; messages: PromptMessage[] } {
  if (value instanceof PromptResult) {
    return { description: value.description, messages: value.messages }
  }
  if (typeof value === 'string') {
    return { messages: [{ role: 'user', content: { type: 'text', text: value } }] }
  }
  if (isPromptMessage(value)) {
    return { messages: [value] }
  }
  if (Array.isArray(value) && value.every(isPromptMessage)) {
    return { messages: value }
  }
  throw new Error(
    `Prompt handler returned an unsupported value. Expected string, PromptMessage, PromptMessage[], or PromptResult.`,
  )
}
