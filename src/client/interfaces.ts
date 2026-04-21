import type {
  CallToolResult,
  Tool,
  Resource,
  ResourceTemplate,
  ResourceContents,
  Prompt,
  GetPromptResult,
} from './results.js'
import type { ProgressHandler } from './handlers.js'

export interface RequestOptions {
  /** Per-request timeout in seconds. Overrides client-level defaultOptions. */
  timeout?: number
  /** AbortSignal for caller-controlled cancellation. */
  signal?: AbortSignal
  /** Additional HTTP headers merged into the request. */
  headers?: Record<string, string>
}

export interface CallToolOptions extends RequestOptions {
  /** Per-call progress handler, overrides the client-level handler for this call. */
  onProgress?: ProgressHandler
}

export interface IToolsClient {
  listTools(options?: RequestOptions): Promise<Tool[]>
  callTool<TData = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<CallToolResult<TData>>
}

export interface IResourcesClient {
  listResources(options?: RequestOptions): Promise<Resource[]>
  listResourceTemplates(options?: RequestOptions): Promise<ResourceTemplate[]>
  readResource(uri: string, options?: RequestOptions): Promise<ResourceContents[]>
}

export interface IPromptsClient {
  listPrompts(options?: RequestOptions): Promise<Prompt[]>
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
  [Symbol.asyncDispose](): Promise<void>
}
