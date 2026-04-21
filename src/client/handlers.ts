import type {
  LoggingLevel,
  CreateMessageRequestParams,
  CreateMessageResult,
  ElicitRequestParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types'

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
) => CreateMessageResult | Promise<CreateMessageResult>

export type ElicitationHandler = (
  params: ElicitRequestParams,
) => ElicitResult | Promise<ElicitResult>

export interface ClientHandlers {
  log?: LogHandler
  progress?: ProgressHandler
  sampling?: SamplingHandler
  elicitation?: ElicitationHandler
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
