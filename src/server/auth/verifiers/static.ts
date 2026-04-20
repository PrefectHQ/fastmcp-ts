import type { AccessToken, TokenVerifier } from '../types'

export function staticTokenVerifier(
  map: Record<string, Partial<Omit<AccessToken, 'token'>>>,
): TokenVerifier {
  return {
    async verify(token: string): Promise<AccessToken> {
      const entry = map[token]
      if (!entry) {
        throw new Error('Unknown token')
      }
      if (entry.expiresAt !== undefined && entry.expiresAt < Math.floor(Date.now() / 1000)) {
        throw new Error('Token has expired')
      }
      return {
        token,
        clientId: entry.clientId,
        scopes: entry.scopes ?? [],
        expiresAt: entry.expiresAt,
        claims: entry.claims ?? {},
      }
    },
  }
}

export function debugTokenVerifier(): TokenVerifier {
  console.warn('[fastmcp] debugTokenVerifier() accepts all bearer tokens — never use in production')
  return {
    async verify(token: string): Promise<AccessToken> {
      if (!token) {
        throw new Error('Empty token')
      }
      return { token, scopes: [], claims: {} }
    },
  }
}
