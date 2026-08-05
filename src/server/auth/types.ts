import type { HttpRequestContext } from '../httpContext'

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
 * Request-level verifier for HTTP deployments where identity does not arrive
 * as a bearer token. The typical case is a trusted reverse proxy that
 * authenticates the caller and forwards the resolved identity as request
 * headers.
 *
 * Called once per HTTP request, before dispatch, with that request's own FULL
 * wire headers (no redaction; `request.redactedHeaderNames` is empty here —
 * the verifier is the credential-handling code). Return an AccessToken to
 * admit the request. The result becomes `ctx.auth`, feeds per-item `auth`
 * checks and list filtering, and its `token` (hashed) keys response-cache
 * partitioning. `token` MUST therefore be a stable, non-empty, per-identity
 * value, such as the verified user id. The server rejects an empty `token`
 * with HTTP 500. Throw `AuthorizationError` to produce 403; any other throw
 * produces 401.
 *
 * SECURITY: request headers are forgeable by anyone who can reach this server
 * directly. Trust them only after verifying provenance: a shared secret the
 * proxy injects, mTLS, or network isolation. Add your provenance-secret
 * header to `FastMCPOptions.http.redactHeaders` so it never surfaces in
 * `ctx.http`. See docs: servers/auth/trusted-proxy.
 *
 * HTTP transports only. On stdio there is no HTTP request; configure a
 * TokenVerifier if you need `FASTMCP_CLI_AUTH_TOKEN` support.
 */
export interface RequestVerifier {
  verifyRequest(request: HttpRequestContext): Promise<AccessToken>
}

/** Narrow a `FastMCPOptions.auth` value to the request-level flavor. */
export function isRequestVerifier(
  v: TokenVerifier | RequestVerifier,
): v is RequestVerifier {
  return 'verifyRequest' in v
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
