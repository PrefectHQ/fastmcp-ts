import type { AccessToken, TokenVerifier } from '../types'
import { VerificationUnavailableError } from '../types'

export interface IntrospectionVerifierOptions {
  endpoint: string
  credentials: { clientId: string; clientSecret: string }
  /** Cache TTL in seconds. Omit or set to 0 to disable caching. */
  cacheTtl?: number
  /** Total introspection deadline in milliseconds. Default: 5000. */
  timeoutMs?: number
}

interface CacheEntry {
  token: AccessToken
  expiresAt: number
}

export function introspectionVerifier(options: IntrospectionVerifierOptions): TokenVerifier {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('introspectionVerifier timeoutMs must be a positive 32-bit integer')
  }
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

      let response: Response | undefined
      let data: {
        active: boolean
        scope?: string
        client_id?: string
        exp?: number
        [key: string]: unknown
      }
      try {
        response = await fetch(options.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${credentials}`,
          },
          body: new URLSearchParams({ token: rawToken }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        })
        if (!response.ok) {
          throw new VerificationUnavailableError({ retryAfter: response.headers.get('retry-after') })
        }
        const answer = await response.json()
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)
          || typeof answer.active !== 'boolean'
          || (answer.active && (
            (answer.scope !== undefined && typeof answer.scope !== 'string')
            || (answer.client_id !== undefined && typeof answer.client_id !== 'string')
            || (answer.exp !== undefined && (typeof answer.exp !== 'number' || !Number.isFinite(answer.exp)))
          ))) {
          throw new Error('Invalid introspection response')
        }
        data = answer
      } catch (cause) {
        if (cause instanceof VerificationUnavailableError) throw cause
        throw new VerificationUnavailableError({ cause })
      } finally {
        await response?.body?.cancel().catch(() => {})
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
