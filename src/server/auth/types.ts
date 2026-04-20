export interface AccessToken {
  /** The raw bearer token string. */
  token: string
  /** The subject/client identifier from the token. */
  clientId?: string
  /** Scopes granted to the token. */
  scopes: string[]
  /** Unix timestamp (seconds) when the token expires. */
  expiresAt?: number
  /** All claims from the token payload. */
  claims: Record<string, unknown>
}

export interface TokenVerifier {
  verify(token: string): Promise<AccessToken>
}

/**
 * Thrown by authorization checks to produce a 403 response.
 * Any other error thrown during verification produces a 401.
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}
