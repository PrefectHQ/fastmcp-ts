import type {
  LoggingLevel,
  CreateMessageRequestParams,
  ElicitRequestParams,
  ElicitResult,
  Tool,
  Resource,
  Prompt,
} from '@modelcontextprotocol/sdk/types'
import type { AnySamplingResult } from './results.js'

export type LogMessage = {
  level: LoggingLevel
  logger?: string
  data: unknown
}

export type LogHandler = (message: LogMessage) => void | Promise<void>

export type ProgressHandler = (
  progress: number,
  total?: number,
  message?: string,
) => void | Promise<void>

export type SamplingHandler = (
  params: CreateMessageRequestParams,
) => AnySamplingResult | Promise<AnySamplingResult>

export type ElicitationHandler = (
  params: ElicitRequestParams,
) => ElicitResult | Promise<ElicitResult>

export type ResourceUpdateHandler = (uri: string) => void | Promise<void>

/**
 * Config for receiving server-initiated list-change notifications.
 * Set debounceMs: 0 in tests for instant delivery.
 */
export type ListChangedHandler<T> = {
  onChanged: (error: Error | null, items: T[] | null) => void | Promise<void>
  /** Whether to auto-fetch the updated list before calling onChanged. Default: true. */
  autoRefresh?: boolean
  /** Debounce window in ms. Default: 300. Set to 0 to disable. */
  debounceMs?: number
}

export interface ClientHandlers {
  log?: LogHandler
  progress?: ProgressHandler
  sampling?: SamplingHandler
  elicitation?: ElicitationHandler
  onToolsListChanged?: ListChangedHandler<Tool>
  onResourcesListChanged?: ListChangedHandler<Resource>
  onPromptsListChanged?: ListChangedHandler<Prompt>
}

export function defaultLogHandler(message: LogMessage): void {
  const prefix = message.logger ? `[${message.logger}]` : '[server]'
  const data =
    typeof message.data === 'string' ? message.data : JSON.stringify(message.data)
  const text = `${prefix} ${data}`
  const level = message.level
  if (level === 'debug') {
    console.debug(text)
  } else if (level === 'warning') {
    console.warn(text)
  } else if (
    level === 'error' ||
    level === 'critical' ||
    level === 'alert' ||
    level === 'emergency'
  ) {
    console.error(text)
  } else {
    console.info(text)
  }
}

export function defaultProgressHandler(
  progress: number,
  total?: number,
  message?: string,
): void {
  const pct = total != null ? ` (${Math.round((progress / total) * 100)}%)` : ''
  const msg = message ? ` — ${message}` : ''
  console.debug(
    `progress: ${progress}${total != null ? `/${total}` : ''}${pct}${msg}`,
  )
}
