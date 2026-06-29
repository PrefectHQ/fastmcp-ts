export type {
  Tool,
  Resource,
  ResourceTemplate,
  ResourceContents,
  TextResourceContents,
  BlobResourceContents,
  Prompt,
  PromptArgument,
  PromptMessage,
  GetPromptResult,
  SamplingMessage,
  CreateMessageResult,
  CreateMessageResultWithTools,
  CreateMessageRequestParams,
  ModelPreferences,
  ToolUseContent,
  ToolResultContent,
  ToolChoice,
  LoggingLevel,
  ContentBlock,
  ElicitRequestParams,
  ElicitResult,
  Root,
} from '@modelcontextprotocol/sdk/types.js'

import type { CreateMessageResult, CreateMessageResultWithTools } from '@modelcontextprotocol/sdk/types.js'

/** Union of the two sampling result shapes the MCP protocol defines. */
export type AnySamplingResult = CreateMessageResult | CreateMessageResultWithTools

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js'

/**
 * The SDK's CallToolResult with a typed generic for structuredContent.
 * Use TData to get typed access to structured tool output.
 */
export type CallToolResult<TData = unknown> = {
  content: ContentBlock[]
  structuredContent: TData | null
  isError: boolean
}

export type CompletionResult = {
  values: string[]
  total?: number
  hasMore?: boolean
}
