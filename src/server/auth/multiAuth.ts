import type { AccessToken, TokenVerifier } from './types'

export function multiAuth(...verifiers: TokenVerifier[]): TokenVerifier {
  return {
    async verify(token: string): Promise<AccessToken> {
      const errors: string[] = []
      for (const verifier of verifiers) {
        try {
          return await verifier.verify(token)
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err))
        }
      }
      throw new Error(`All auth sources rejected the token: ${errors.join('; ')}`)
    },
  }
}
