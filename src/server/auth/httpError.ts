import type { ServerResponse } from 'node:http'
import { AuthorizationError, VerificationUnavailableError } from './types'

/** Shared by bearer and request verifiers, before either protocol era dispatches. */
export function writeVerifierError(res: ServerResponse, error: unknown, challenge?: string): void {
  if (error instanceof VerificationUnavailableError) {
    res.writeHead(503, {
      'Content-Type': 'application/json',
      ...(error.retryAfterSeconds !== undefined && { 'Retry-After': String(error.retryAfterSeconds) }),
    }).end(JSON.stringify({ error: 'Token verification is temporarily unavailable' }))
  } else if (error instanceof AuthorizationError) {
    res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }))
  } else {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      ...(challenge && { 'WWW-Authenticate': challenge }),
    }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Authentication failed' }))
  }
}
