import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
// ---------------------------------------------------------------------------
// OAuthToken — internal type used by ClientCredentials for expiry tracking.
// Not the SDK's OAuthTokens: we track expires_at in milliseconds.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// KeyValueStore — single persistence interface for all auth state
// ---------------------------------------------------------------------------

export type KeyValueStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

// ---------------------------------------------------------------------------
// InMemoryStore
// ---------------------------------------------------------------------------

export class InMemoryStore implements KeyValueStore {
  private readonly _map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this._map.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this._map.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this._map.delete(key)
  }
}

// ---------------------------------------------------------------------------
// FileTokenStorage
// ---------------------------------------------------------------------------

export class FileTokenStorage implements KeyValueStore {
  private readonly _explicitPath?: string
  private _resolvedPath?: string

  constructor(path?: string) {
    this._explicitPath = path
  }

  private async _path(): Promise<string> {
    if (this._resolvedPath) return this._resolvedPath
    if (this._explicitPath) return (this._resolvedPath = this._explicitPath)
    const { homedir } = await import('os')
    const { join } = await import('path')
    return (this._resolvedPath = join(homedir(), '.fastmcp', 'tokens.json'))
  }

  private async _readAll(): Promise<Record<string, string>> {
    const fs = await import('fs/promises')
    try {
      const raw = await fs.readFile(await this._path(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, string>
      }
      return {}
    } catch {
      return {}
    }
  }

  private async _writeAll(data: Record<string, string>): Promise<void> {
    const fs = await import('fs/promises')
    const { dirname } = await import('path')
    const path = await this._path()
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, path)
  }

  async get(key: string): Promise<string | null> {
    const data = await this._readAll()
    return data[key] ?? null
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this._readAll()
    data[key] = value
    await this._writeAll(data)
  }

  async delete(key: string): Promise<void> {
    const data = await this._readAll()
    if (!(key in data)) return
    delete data[key]
    await this._writeAll(data)
  }
}

// ---------------------------------------------------------------------------
// OAuth — implements OAuthClientProvider (authorization code + PKCE flow)
// ---------------------------------------------------------------------------

export interface OAuthOptions {
  /** Pre-registered client ID. When set, Dynamic Client Registration is skipped. */
  clientId?: string
  /** Pre-registered client secret. */
  clientSecret?: string
  /** Requested OAuth scopes (space-separated string or array). */
  scopes?: string | string[]
  /** Client name used in Dynamic Client Registration. Default: "FastMCP Client". */
  clientName?: string
  /** Persistent key-value store for tokens, client info, and discovery state. Default: in-memory. */
  store?: KeyValueStore
  /**
   * Port for the local OAuth callback server. Default: 8765.
   * The port must be consistent across calls because it is registered as the
   * redirect_uri during Dynamic Client Registration.
   */
  callbackPort?: number
  /**
   * Override how the authorization URL is opened. When not provided the
   * system browser is launched. Inject a no-op or mock here for testing.
   */
  onRedirect?: (url: URL) => void | Promise<void>
}

export class OAuth implements OAuthClientProvider {
  private _serverUrl = ''
  private readonly _clientId?: string
  private readonly _clientSecret?: string
  private readonly _scopes?: string
  private readonly _clientName: string
  private readonly _store: KeyValueStore
  private readonly _callbackPort: number
  private readonly _onRedirect?: (url: URL) => void | Promise<void>

  private _codeVerifier: string | undefined
  protected _callbackPromise: Promise<string> | null = null
  protected _callbackResolve: ((code: string) => void) | null = null
  protected _callbackReject: ((err: Error) => void) | null = null
  private _callbackServer: { close(): void } | null = null
  private _actualCallbackPort: number | null = null

  constructor(options: OAuthOptions = {}) {
    this._clientId = options.clientId
    this._clientSecret = options.clientSecret
    this._scopes = Array.isArray(options.scopes)
      ? options.scopes.join(' ')
      : options.scopes
    this._clientName = options.clientName ?? 'FastMCP Client'
    this._store = options.store ?? new InMemoryStore()
    this._callbackPort = options.callbackPort ?? 8765
    this._onRedirect = options.onRedirect
  }

  /**
   * Binds the MCP server URL so that all storage keys are namespaced by it.
   * Called by Client before connecting.
   */
  _bind(serverUrl: string): void {
    this._serverUrl = serverUrl
  }

  // ---- OAuthClientProvider interface ----

  get redirectUrl(): string | URL {
    const port = this._actualCallbackPort ?? this._callbackPort
    return `http://localhost:${port}/callback`
  }

  get clientMetadata(): OAuthClientMetadata {
    const port = this._actualCallbackPort ?? this._callbackPort
    return {
      redirect_uris: [`http://localhost:${port}/callback`],
      token_endpoint_auth_method: this._clientSecret ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: this._clientName,
      ...(this._scopes ? { scope: this._scopes } : {}),
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this._clientId) {
      return {
        client_id: this._clientId,
        ...(this._clientSecret ? { client_secret: this._clientSecret } : {}),
      }
    }
    const raw = await this._store.get(this._key('client_info'))
    if (!raw) return undefined
    return JSON.parse(raw) as OAuthClientInformationMixed
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (this._clientId) return  // pre-registered — never overwrite with DCR response
    await this._store.set(this._key('client_info'), JSON.stringify(info))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = await this._store.get(this._key('tokens'))
    if (!raw) return undefined
    return JSON.parse(raw) as OAuthTokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this._store.set(this._key('tokens'), JSON.stringify(tokens))
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this._armCallbackPromise()
    await this._startCallbackServer()
    if (this._onRedirect) {
      await this._onRedirect(authorizationUrl)
    } else {
      await openBrowser(authorizationUrl.toString())
    }
  }

  /**
   * Creates the pending-callback promise that {@link waitForCallback} awaits.
   * Subclasses (e.g. BrowserOAuth) call this before opening their own redirect.
   */
  protected _armCallbackPromise(): void {
    this._callbackPromise = new Promise<string>((resolve, reject) => {
      this._callbackResolve = resolve
      this._callbackReject = reject
    })
    // Suppress unhandled-rejection warnings — the promise is observed via Promise.race.
    this._callbackPromise.catch(() => {})
  }

  /** Resolves the pending callback with an authorization code. */
  protected _resolveCallback(code: string): void {
    this._callbackResolve?.(code)
  }

  /** Rejects the pending callback with an error. */
  protected _rejectCallback(err: Error): void {
    this._callbackReject?.(err)
  }

  /**
   * Races the pending callback promise against a timeout and clears the
   * promise state. Subclasses reuse this and add their own teardown.
   */
  protected async _awaitCallback(timeoutMs: number): Promise<string> {
    if (!this._callbackPromise) {
      throw new Error('No pending OAuth callback — call redirectToAuthorization() first')
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('OAuth callback timed out waiting for authorization')),
        timeoutMs,
      ),
    )
    try {
      return await Promise.race([this._callbackPromise, timeout])
    } finally {
      this._callbackPromise = null
      this._callbackResolve = null
      this._callbackReject = null
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (this._codeVerifier === undefined) {
      throw new Error('No PKCE code verifier has been saved')
    }
    return this._codeVerifier
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      await this._store.delete(this._key('tokens'))
    }
    if (scope === 'all' || scope === 'client') {
      await this._store.delete(this._key('client_info'))
    }
    if (scope === 'all' || scope === 'verifier') {
      this._codeVerifier = undefined
    }
    if (scope === 'all' || scope === 'discovery') {
      await this._store.delete(this._key('discovery'))
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this._store.set(this._key('discovery'), JSON.stringify(state))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const raw = await this._store.get(this._key('discovery'))
    if (!raw) return undefined
    return JSON.parse(raw) as OAuthDiscoveryState
  }

  // ---- Internal helpers ----

  /**
   * Returns the actual port the callback server bound to.
   * Only populated after redirectToAuthorization() has been called.
   */
  get callbackServerPort(): number | null {
    return this._actualCallbackPort
  }

  /**
   * Waits for the OAuth authorization code to arrive via the callback server,
   * then stops the server and resolves with the code.
   *
   * Must be called after the UnauthorizedError thrown by connect() is caught.
   */
  async waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<string> {
    try {
      return await this._awaitCallback(timeoutMs)
    } finally {
      this._stopCallbackServer()
    }
  }

  private _key(type: string): string {
    return `${this._serverUrl}/${type}`
  }

  private async _startCallbackServer(): Promise<void> {
    if (this._callbackServer) return
    const http = await import('http')
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost`)
        const error = url.searchParams.get('error')
        if (error && this._callbackReject) {
          const description = url.searchParams.get('error_description') ?? error
          this._callbackReject(new Error(`OAuth authorization denied: ${description}`))
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(
            '<html><body><h1>Authorization denied</h1><p>You may close this tab.</p></body></html>',
          )
          return
        }
        const code = url.searchParams.get('code')
        if (code && this._callbackResolve) {
          this._callbackResolve(code)
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(
            '<html><body><h1>Authorization complete</h1><p>You may close this tab.</p></body></html>',
          )
        } else {
          res.writeHead(400)
          res.end('Missing code parameter')
        }
      })
      server.on('error', reject)
      server.listen(this._callbackPort, () => {
        const addr = server.address()
        if (addr && typeof addr !== 'string') {
          this._actualCallbackPort = addr.port
        }
        this._callbackServer = server
        resolve()
      })
    })
  }

  private _stopCallbackServer(): void {
    this._callbackServer?.close()
    this._callbackServer = null
    this._actualCallbackPort = null
  }
}

// ---------------------------------------------------------------------------
// BearerAuth
// ---------------------------------------------------------------------------

export class BearerAuth {
  private readonly _token: string

  constructor(token: string) {
    // Strip any existing Bearer prefix to avoid double-prepending
    this._token = token.startsWith('Bearer ') ? token.slice(7) : token
  }

  getHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this._token}` }
  }
}

// ---------------------------------------------------------------------------
// ClientCredentials — OAuth 2.0 client credentials grant (machine-to-machine)
// ---------------------------------------------------------------------------

export interface ClientCredentialsOptions {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  scope?: string
  store?: KeyValueStore
  /** How many seconds before expiry to proactively re-fetch. Default: 60. */
  refreshBufferSeconds?: number
}

const DEFAULT_REFRESH_BUFFER_SECONDS = 60

function normalizeToken(token: OAuthToken): OAuthToken {
  if (typeof token.expires_at === 'number' && token.expires_at > 0) {
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

export class ClientCredentials {
  readonly kind = 'client_credentials' as const

  private readonly _tokenEndpoint: string
  private readonly _clientId: string
  private readonly _clientSecret: string
  private readonly _scope?: string
  private readonly _store: KeyValueStore
  private readonly _bufferMs: number
  private _fetchPromise: Promise<OAuthToken> | null = null

  constructor(options: ClientCredentialsOptions) {
    this._tokenEndpoint = options.tokenEndpoint
    this._clientId = options.clientId
    this._clientSecret = options.clientSecret
    this._scope = options.scope
    this._store = options.store ?? new InMemoryStore()
    this._bufferMs =
      (options.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this._getValidToken()
    const type = token.token_type?.trim() || 'Bearer'
    return { Authorization: `${type} ${token.access_token}` }
  }

  private get _tokenKey(): string {
    return `${this._tokenEndpoint}/token`
  }

  private async _getValidToken(): Promise<OAuthToken> {
    const raw = await this._store.get(this._tokenKey)
    if (raw) {
      const normalized = normalizeToken(JSON.parse(raw) as OAuthToken)
      if (!isExpiring(normalized, this._bufferMs)) return normalized
    }
    return await this._doFetch()
  }

  private async _doFetch(): Promise<OAuthToken> {
    this._fetchPromise ??= (async () => {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this._clientId,
        client_secret: this._clientSecret,
      })
      if (this._scope) params.set('scope', this._scope)

      const response = await fetch(this._tokenEndpoint, {
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
      await this._store.set(this._tokenKey, JSON.stringify(token))
      return token
    })().finally(() => {
      this._fetchPromise = null
    })

    return this._fetchPromise
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('child_process')
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' })
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  }
}
