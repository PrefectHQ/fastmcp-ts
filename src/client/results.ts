import type { CreateMessageResult, CreateMessageResultWithTools, ContentBlock } from "@modelcontextprotocol/server";

export type {
  Tool,
  Resource,
  ResourceTemplateType as ResourceTemplate,
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
} from '@modelcontextprotocol/server'
/** Union of the two sampling result shapes the MCP protocol defines. */
export type AnySamplingResult = CreateMessageResult | CreateMessageResultWithTools
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
