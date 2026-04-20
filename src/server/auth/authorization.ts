import type { AccessToken } from './types'
import { AuthorizationError } from './types'

export type AuthCheck = (token: AccessToken) => void | Promise<void>

export function requireScopes(...scopes: string[]): AuthCheck {
  return async (token) => {
    for (const scope of scopes) {
      if (!token.scopes.includes(scope)) {
        throw new AuthorizationError(`Missing required scope: "${scope}"`)
      }
    }
  }
}
