import { AsyncLocalStorage } from 'node:async_hooks'
import type { AccessToken } from './auth/types'

export interface McpContext {
  auth?: AccessToken
}

export const contextStore = new AsyncLocalStorage<McpContext>()
