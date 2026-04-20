import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients'
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types'

export interface OAuthProxyOptions {
  /** Pre-registered credentials this proxy uses when talking to the upstream server. */
  upstreamCredentials: {
    clientId: string
    clientSecret?: string
  }
  /** Upstream OAuth server endpoint URLs. */
  endpoints: {
    authorizationUrl: string
    tokenUrl: string
    revocationUrl?: string
  }
  /**
   * Verifies an access token issued by the upstream and returns information about it.
   * Called for every MCP request to validate the bearer token.
   */
  verifyAccessToken: (token: string) => Promise<AuthInfo>
}

/**
 * Creates an OAuth provider that proxies to an existing upstream OAuth server using
 * pre-registered credentials.
 *
 * MCP clients interact with this proxy using Dynamic Client Registration. The proxy
 * presents a DCR-compliant interface while internally using its own fixed credentials
 * (`upstreamCredentials`) when communicating with the upstream authorization server.
 */
export function oauthProxy(options: OAuthProxyOptions): OAuthServerProvider {
  const clients = new Map<string, OAuthClientInformationFull>()

  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId) {
      return clients.get(clientId)
    },
    // DCR for incoming MCP clients — stored locally, not proxied upstream
    async registerClient(client) {
      const full = client as OAuthClientInformationFull
      clients.set(full.client_id, full)
      return full
    },
  }

  return {
    clientsStore,
    // Let the upstream server validate PKCE — we pass code_verifier through
    skipLocalPkceValidation: true as const,

    async authorize(_client, params, res) {
      // Redirect to upstream using the proxy's registered client_id
      const targetUrl = new URL(options.endpoints.authorizationUrl)
      targetUrl.searchParams.set('client_id', options.upstreamCredentials.clientId)
      targetUrl.searchParams.set('response_type', 'code')
      targetUrl.searchParams.set('redirect_uri', params.redirectUri)
      targetUrl.searchParams.set('code_challenge', params.codeChallenge)
      targetUrl.searchParams.set('code_challenge_method', 'S256')
      if (params.state) targetUrl.searchParams.set('state', params.state)
      if (params.scopes?.length) targetUrl.searchParams.set('scope', params.scopes.join(' '))
      res.redirect(targetUrl.toString())
    },

    async challengeForAuthorizationCode() {
      // PKCE is validated by the upstream; returning empty string skips local validation
      return ''
    },

    async exchangeAuthorizationCode(_client, authorizationCode, codeVerifier, redirectUri): Promise<OAuthTokens> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: options.upstreamCredentials.clientId,
        code: authorizationCode,
      })
      if (options.upstreamCredentials.clientSecret) {
        body.set('client_secret', options.upstreamCredentials.clientSecret)
      }
      if (codeVerifier) body.set('code_verifier', codeVerifier)
      if (redirectUri) body.set('redirect_uri', redirectUri)

      const response = await fetch(options.endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Upstream token exchange failed: ${response.status}`)
      }
      return response.json() as Promise<OAuthTokens>
    },

    async exchangeRefreshToken(_client, refreshToken, scopes): Promise<OAuthTokens> {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: options.upstreamCredentials.clientId,
        refresh_token: refreshToken,
      })
      if (options.upstreamCredentials.clientSecret) {
        body.set('client_secret', options.upstreamCredentials.clientSecret)
      }
      if (scopes?.length) body.set('scope', scopes.join(' '))

      const response = await fetch(options.endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Upstream token refresh failed: ${response.status}`)
      }
      return response.json() as Promise<OAuthTokens>
    },

    verifyAccessToken: options.verifyAccessToken,

    ...(options.endpoints.revocationUrl
      ? {
          async revokeToken(
            _client: OAuthClientInformationFull,
            request: OAuthTokenRevocationRequest,
          ): Promise<void> {
            const body = new URLSearchParams({
              token: request.token,
              client_id: options.upstreamCredentials.clientId,
            })
            if (options.upstreamCredentials.clientSecret) {
              body.set('client_secret', options.upstreamCredentials.clientSecret)
            }
            if (request.token_type_hint) {
              body.set('token_type_hint', request.token_type_hint)
            }
            const response = await fetch(options.endpoints.revocationUrl!, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            })
            if (!response.ok) {
              await response.body?.cancel()
              // RFC 7009 §2.2: servers should not signal errors on revocation
            }
          },
        }
      : {}),
  }
}
