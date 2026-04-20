import type { AccessToken, TokenVerifier } from '../types'

export interface IntrospectionVerifierOptions {
  endpoint: string
  credentials: { clientId: string; clientSecret: string }
  /** Cache TTL in seconds. Omit or set to 0 to disable caching. */
  cacheTtl?: number
}

interface CacheEntry {
  token: AccessToken
  expiresAt: number
}

export function introspectionVerifier(options: IntrospectionVerifierOptions): TokenVerifier {
  const cache = options.cacheTtl ? new Map<string, CacheEntry>() : null

  return {
    async verify(rawToken: string): Promise<AccessToken> {
      if (cache) {
        const cached = cache.get(rawToken)
        if (cached && Date.now() < cached.expiresAt) {
          return cached.token
        }
        cache.delete(rawToken)
      }

      const credentials = Buffer.from(
        `${options.credentials.clientId}:${options.credentials.clientSecret}`,
      ).toString('base64')

      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({ token: rawToken }),
      })

      if (!response.ok) {
        throw new Error(`Introspection endpoint returned ${response.status}`)
      }

      const data = (await response.json()) as {
        active: boolean
        scope?: string
        client_id?: string
        exp?: number
        [key: string]: unknown
      }

      if (!data.active) {
        throw new Error('Token is not active')
      }

      const accessToken: AccessToken = {
        token: rawToken,
        clientId: data.client_id,
        scopes: data.scope ? data.scope.split(' ').filter(Boolean) : [],
        expiresAt: data.exp,
        claims: data as Record<string, unknown>,
      }

      if (cache && options.cacheTtl) {
        cache.set(rawToken, {
          token: accessToken,
          expiresAt: Date.now() + options.cacheTtl * 1000,
        })
      }

      return accessToken
    },
  }
}
