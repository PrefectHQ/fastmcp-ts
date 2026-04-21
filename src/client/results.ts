export type {
  Tool,
  Resource,
  ResourceTemplate,
  ResourceContents,
  Prompt,
  PromptArgument,
  PromptMessage,
  GetPromptResult,
  SamplingMessage,
  CreateMessageResult,
  CreateMessageRequestParams,
  LoggingLevel,
  ContentBlock,
  ElicitRequestParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types'

import type { ContentBlock } from '@modelcontextprotocol/sdk/types'

/**
 * The SDK's CallToolResult with a typed generic for structuredContent.
 * Use TData to get typed access to structured tool output.
 */
export type CallToolResult<TData = unknown> = {
  content: ContentBlock[]
  structuredContent: TData | null
  isError: boolean
}
