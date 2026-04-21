export type OAuthToken = {
  access_token: string
  token_type?: string
  refresh_token?: string
  /** Unix timestamp in milliseconds (normalized internally). */
  expires_at?: number
  /** Seconds until expiry — used to compute expires_at on receipt. */
  expires_in?: number
  scope?: string
}

export type OAuthContext = {
  serverUrl: string
  tokenEndpoint?: string
  clientId?: string
  clientSecret?: string
  scope?: string
}

export type TokenStorageAdapter = {
  getToken(): Promise<OAuthToken | null>
  setToken(token: OAuthToken | null): Promise<void>
}

export type TokenRefresher = (
  token: OAuthToken,
  context: OAuthContext,
) => Promise<OAuthToken>

export interface OAuthOptions {
  serverUrl?: string
  tokenEndpoint?: string
  clientId?: string
  clientSecret?: string
  scope?: string
  tokenStorageAdapter?: TokenStorageAdapter
  tokenRefresher?: TokenRefresher
  /** How many seconds before expiry to proactively refresh. Default: 60. */
  refreshBufferSeconds?: number
}

const DEFAULT_REFRESH_BUFFER_SECONDS = 60

class InMemoryTokenStorage implements TokenStorageAdapter {
  private token: OAuthToken | null = null
  async getToken(): Promise<OAuthToken | null> {
    return this.token
  }
  async setToken(token: OAuthToken | null): Promise<void> {
    this.token = token
  }
}

function normalizeToken(token: OAuthToken): OAuthToken {
  if (typeof token.expires_at === 'number' && token.expires_at > 0) {
    // Treat as seconds if the value looks like a Unix timestamp in seconds
    if (token.expires_at < 1e10) {
      return { ...token, expires_at: token.expires_at * 1000 }
    }
    return token
  }
  if (typeof token.expires_in === 'number' && token.expires_in > 0) {
    return { ...token, expires_at: Date.now() + token.expires_in * 1000 }
  }
  return token
}

function isExpiring(token: OAuthToken, bufferMs: number): boolean {
  if (token.expires_at == null) return false
  return token.expires_at - Date.now() <= bufferMs
}

async function defaultRefresher(
  token: OAuthToken,
  ctx: OAuthContext,
): Promise<OAuthToken> {
  if (!ctx.tokenEndpoint) {
    throw new Error('OAuth refresh requires tokenEndpoint')
  }
  if (!token.refresh_token) {
    throw new Error('OAuth refresh requires a refresh_token')
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  })
  if (ctx.clientId) params.set('client_id', ctx.clientId)
  if (ctx.clientSecret) params.set('client_secret', ctx.clientSecret)
  if (ctx.scope) params.set('scope', ctx.scope)

  const response = await fetch(ctx.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `OAuth token refresh failed (${response.status})${detail ? `: ${detail}` : ''}`,
    )
  }

  const refreshed = (await response.json()) as Partial<OAuthToken>
  if (!refreshed.access_token) {
    throw new Error('OAuth refresh response missing access_token')
  }
  return {
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? token.refresh_token,
  }
}

export class OAuth {
  private readonly context: OAuthContext
  private readonly storage: TokenStorageAdapter
  private readonly refresher: TokenRefresher
  private readonly bufferMs: number
  private refreshPromise: Promise<OAuthToken> | null = null

  constructor(options: OAuthOptions = {}) {
    this.context = {
      serverUrl: options.serverUrl ?? '',
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      scope: options.scope,
    }
    this.storage = options.tokenStorageAdapter ?? new InMemoryTokenStorage()
    this.refresher = options.tokenRefresher ?? defaultRefresher
    this.bufferMs =
      (options.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000
  }

  async getToken(): Promise<OAuthToken | null> {
    return this.storage.getToken()
  }

  async setToken(token: OAuthToken | null): Promise<void> {
    const normalized = token ? normalizeToken(token) : null
    await this.storage.setToken(normalized)
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getValidToken()
    const type = token.token_type?.trim() || 'Bearer'
    return { Authorization: `${type} ${token.access_token}` }
  }

  private async getValidToken(): Promise<OAuthToken> {
    const stored = await this.storage.getToken()
    if (!stored) {
      throw new Error(
        'OAuth token missing — call setToken() before connecting',
      )
    }
    const token = normalizeToken(stored)
    if (!isExpiring(token, this.bufferMs)) return token
    if (!token.refresh_token) {
      throw new Error('OAuth token expired and no refresh_token available')
    }
    return await this.doRefresh(token)
  }

  private async doRefresh(token: OAuthToken): Promise<OAuthToken> {
    // Coalesce concurrent refresh calls into a single request
    this.refreshPromise ??= (async () => {
      const refreshed = normalizeToken(await this.refresher(token, this.context))
      await this.storage.setToken(refreshed)
      return refreshed
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }
}

export class BearerAuth {
  private readonly token: string

  constructor(token: string) {
    this.token = token
  }

  getHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` }
  }
}

export interface ClientCredentialsOptions {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  scope?: string
  tokenStorageAdapter?: TokenStorageAdapter
  /** How many seconds before expiry to proactively re-fetch. Default: 60. */
  refreshBufferSeconds?: number
}

export class ClientCredentials {
  readonly kind = 'client_credentials' as const

  private readonly tokenEndpoint: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly scope: string | undefined
  private readonly storage: TokenStorageAdapter
  private readonly bufferMs: number
  private fetchPromise: Promise<OAuthToken> | null = null

  constructor(options: ClientCredentialsOptions) {
    this.tokenEndpoint = options.tokenEndpoint
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.scope = options.scope
    this.storage = options.tokenStorageAdapter ?? new InMemoryTokenStorage()
    this.bufferMs =
      (options.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getValidToken()
    const type = token.token_type?.trim() || 'Bearer'
    return { Authorization: `${type} ${token.access_token}` }
  }

  private async getValidToken(): Promise<OAuthToken> {
    const stored = await this.storage.getToken()
    if (stored) {
      const normalized = normalizeToken(stored)
      if (!isExpiring(normalized, this.bufferMs)) return normalized
    }
    return await this.doFetch()
  }

  private async doFetch(): Promise<OAuthToken> {
    // Coalesce concurrent calls into a single in-flight request.
    this.fetchPromise ??= (async () => {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      })
      if (this.scope) params.set('scope', this.scope)

      const response = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(
          `ClientCredentials token fetch failed (${response.status})${detail ? `: ${detail}` : ''}`,
        )
      }

      const data = (await response.json()) as Partial<OAuthToken>
      if (!data.access_token) {
        throw new Error('ClientCredentials token response missing access_token')
      }

      const token = normalizeToken(data as OAuthToken)
      await this.storage.setToken(token)
      return token
    })().finally(() => {
      this.fetchPromise = null
    })

    return this.fetchPromise
  }
}
