import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types'

export interface OAuthProviderOptions {
  /**
   * Called during the authorization step. Implementations must eventually redirect
   * to `params.redirectUri` with a `code` query parameter (and `state` if present).
   *
   * If omitted, all authorization requests are auto-approved immediately — suitable
   * for testing and development only.
   */
  onAuthorize?: (
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) => Promise<void>
  /** Scopes supported by this server, advertised in OAuth metadata. */
  scopes?: string[]
  /** Access token lifetime in seconds. Default: 3600. */
  tokenTtl?: number
}

/**
 * Creates an in-memory OAuth 2.1 server provider with Dynamic Client Registration support.
 *
 * Suitable for development, testing, and simple deployments where persistence is not required.
 * All state (clients, codes, tokens) is held in memory and lost on restart.
 */
export function oauthProvider(options: OAuthProviderOptions = {}): OAuthServerProvider {
  const clients = new Map<string, OAuthClientInformationFull>()
  const codes = new Map<string, { client: OAuthClientInformationFull; params: AuthorizationParams }>()
  const tokens = new Map<string, { clientId: string; scopes: string[]; expiresAt: number }>()

  // The SDK registration handler generates client_id and other fields before calling
  // registerClient, so at runtime the argument is always a full OAuthClientInformationFull.
  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId) {
      return clients.get(clientId)
    },
    async registerClient(client) {
      const full = client as OAuthClientInformationFull
      clients.set(full.client_id, full)
      return full
    },
  }

  return {
    clientsStore,

    async authorize(client, params, res) {
      if (options.onAuthorize) {
        return options.onAuthorize(client, params, res)
      }
      // Default: auto-approve — issue code and redirect immediately
      const code = randomUUID()
      codes.set(code, { client, params })
      const redirectUrl = new URL(params.redirectUri)
      redirectUrl.searchParams.set('code', code)
      if (params.state) redirectUrl.searchParams.set('state', params.state)
      res.redirect(redirectUrl.toString())
    },

    async challengeForAuthorizationCode(_client, authorizationCode) {
      const data = codes.get(authorizationCode)
      if (!data) throw new Error('Invalid authorization code')
      return data.params.codeChallenge
    },

    async exchangeAuthorizationCode(client, authorizationCode) {
      const data = codes.get(authorizationCode)
      if (!data) throw new Error('Invalid authorization code')
      if (data.client.client_id !== client.client_id) {
        throw new Error('Authorization code was not issued to this client')
      }
      codes.delete(authorizationCode)

      const token = randomUUID()
      const ttl = options.tokenTtl ?? 3600
      tokens.set(token, {
        clientId: client.client_id,
        scopes: data.params.scopes ?? [],
        expiresAt: Math.floor(Date.now() / 1000) + ttl,
      })
      return {
        access_token: token,
        token_type: 'bearer',
        expires_in: ttl,
        scope: (data.params.scopes ?? []).join(' '),
      }
    },

    async exchangeRefreshToken() {
      throw new Error('Refresh tokens are not supported by this provider')
    },

    async verifyAccessToken(token): Promise<AuthInfo> {
      const data = tokens.get(token)
      if (!data) throw new Error('Invalid token')
      if (data.expiresAt < Math.floor(Date.now() / 1000)) throw new Error('Token has expired')
      return {
        token,
        clientId: data.clientId,
        scopes: data.scopes,
        expiresAt: data.expiresAt,
      }
    },
  }
}
