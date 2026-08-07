import type {
  CallToolResult,
  CompletionResult,
  Tool,
  Resource,
  ResourceTemplate,
  TextResourceContents,
  BlobResourceContents,
  Prompt,
  GetPromptResult,
} from './results.js'
import type { CacheMode } from '@modelcontextprotocol/client'
import type { ProgressHandler, ResourceUpdateHandler } from './handlers.js'
import type { LoggingLevel } from "@modelcontextprotocol/server";

export interface RequestOptions {
  /** Per-request timeout in seconds. Overrides client-level defaultOptions. */
  timeout?: number
  /** AbortSignal for caller-controlled cancellation. */
  signal?: AbortSignal
}

export interface CacheableRequestOptions extends RequestOptions {
  /** How this request uses the client response cache. Defaults to `use`. */
  cacheMode?: CacheMode
}

export interface CallToolOptions extends RequestOptions {
  /** Per-call progress handler, overrides the client-level handler for this call. */
  onProgress?: ProgressHandler
}

export interface IToolsClient {
  listTools(options?: CacheableRequestOptions): Promise<Tool[]>
  callTool<TData = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<CallToolResult<TData>>
}

export interface IResourcesClient {
  listResources(options?: CacheableRequestOptions): Promise<Resource[]>
  listResourceTemplates(options?: CacheableRequestOptions): Promise<ResourceTemplate[]>
  readResource(uri: string, options?: CacheableRequestOptions): Promise<Array<TextResourceContents | BlobResourceContents>>
  subscribeResource(uri: string, handler: ResourceUpdateHandler, options?: RequestOptions): Promise<void>
  unsubscribeResource(uri: string, options?: RequestOptions): Promise<void>
}

export interface IPromptsClient {
  listPrompts(options?: CacheableRequestOptions): Promise<Prompt[]>
  getPrompt(
    name: string,
    args?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<GetPromptResult>
}

export interface IClient extends IToolsClient, IResourcesClient, IPromptsClient {
  connect(): Promise<void>
  close(): Promise<void>
  isConnected(): boolean
  ping(options?: RequestOptions): Promise<boolean>
  complete(
    ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string },
    argument: { name: string; value: string },
    context?: { arguments?: Record<string, string> },
    options?: RequestOptions,
  ): Promise<CompletionResult>
  setLogLevel(level: LoggingLevel, options?: RequestOptions): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}
