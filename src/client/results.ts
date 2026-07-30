import type { CallToolResult as SdkCallToolResult } from '@modelcontextprotocol/client'
import type { CreateMessageResult, CreateMessageResultWithTools } from "@modelcontextprotocol/server";

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
 * The intersection retains its open extension fields while narrowing the two
 * values FastMCP normalizes.
 */
export type CallToolResult<TData = unknown> = SdkCallToolResult & {
  structuredContent: TData | null
  isError: boolean
}

export function normalizeCallToolResult<TData = unknown>(
  result: SdkCallToolResult,
): CallToolResult<TData> {
  return {
    ...result,
    structuredContent: (result.structuredContent as TData | undefined) ?? null,
    isError: result.isError === true,
  }
}

export type CompletionResult = {
  values: string[]
  total?: number
  hasMore?: boolean
}
