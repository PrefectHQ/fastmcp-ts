import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AccessToken, TokenVerifier } from '../types'

export interface JwtVerifierOptions {
  jwksUri: string
  issuer?: string
  audience?: string | string[]
  /** Clock skew tolerance in seconds. Default: 0. */
  leeway?: number
}

export function jwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  const JWKS = createRemoteJWKSet(new URL(options.jwksUri))

  return {
    async verify(token: string): Promise<AccessToken> {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: options.issuer,
        audience: options.audience,
        clockTolerance: options.leeway ?? 0,
      })

      const scopes =
        typeof payload.scope === 'string'
          ? payload.scope.split(' ').filter(Boolean)
          : Array.isArray(payload.scope)
            ? (payload.scope as string[])
            : []

      return {
        token,
        clientId: typeof payload.sub === 'string' ? payload.sub : undefined,
        scopes,
        expiresAt: payload.exp,
        claims: payload as Record<string, unknown>,
      }
    },
  }
}
