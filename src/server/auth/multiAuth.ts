import type { AccessToken, TokenVerifier } from './types'
import { VerificationUnavailableError } from './types'

export function multiAuth(...verifiers: TokenVerifier[]): TokenVerifier {
  return {
    async verify(token: string): Promise<AccessToken> {
      const errors: string[] = []
      let unavailable: VerificationUnavailableError | undefined
      for (const verifier of verifiers) {
        try {
          return await verifier.verify(token)
        } catch (err) {
          if (err instanceof VerificationUnavailableError) unavailable ??= err
          errors.push(err instanceof Error ? err.message : String(err))
        }
      }
      if (unavailable) throw unavailable
      throw new Error(`All auth sources rejected the token: ${errors.join('; ')}`)
    },
  }
}
