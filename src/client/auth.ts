import {
  validateClientMetadataUrl,
  createPrivateKeyJwtAuth,
  requestJwtAuthorizationGrant,
  exchangeJwtAuthGrant,
  type OAuthClientProvider,
  type OAuthClientInformationContext,
  type OAuthDiscoveryState,
  type OAuthClientMetadata,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type AddClientAuthentication,
  type ClientAuthMethod,
} from "@modelcontextprotocol/client";

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
// AsyncHeaderAuth — the shape of a token-acquiring auth provider
// ---------------------------------------------------------------------------

/**
 * An auth provider that acquires a token asynchronously and injects it as a
 * request header per request. {@link ClientCredentials}, {@link JwtBearerAuth},
 * and {@link EnterpriseManagedAuth} all implement it. The transport recognizes
 * these by their `kind` discriminant and injects `getHeaders()` on every
 * request via a custom fetch wrapper (unlike static `BearerAuth`, whose header
 * never changes, or interactive `OAuth`, which the SDK transport drives itself).
 */
export interface AsyncHeaderAuth {
  readonly kind: string
  getHeaders(): Promise<Record<string, string>>
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
  /**
   * Client ID Metadata Document URL (SEP-991 / CIMD) — an HTTPS URL, with a
   * non-root path, that serves this client's metadata document. When the
   * authorization server advertises `client_id_metadata_document_supported`,
   * the SDK's `auth()` orchestrator uses this URL directly as the `client_id`
   * and skips Dynamic Client Registration entirely. Falls back to normal DCR
   * (or `clientId`, if set) when the server doesn't support CIMD. Validated
   * eagerly in the constructor.
   */
  clientMetadataUrl?: string
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
  readonly clientMetadataUrl?: string

  private _codeVerifier: string | undefined
  protected _callbackPromise: Promise<URLSearchParams> | null = null
  protected _callbackResolve: ((params: URLSearchParams) => void) | null = null
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
    // SEP-991: validated eagerly so a malformed clientMetadataUrl fails fast
    // at construction rather than deep inside the auth() flow.
    validateClientMetadataUrl(options.clientMetadataUrl)
    this.clientMetadataUrl = options.clientMetadataUrl
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
      // grant_types is intentionally omitted: the SDK's resolveClientMetadata()
      // defaults interactive providers (those with a redirectUrl, like this one)
      // to ['authorization_code', 'refresh_token'] (SEP-2207) — authorization
      // servers that gate refresh-token issuance on the registered grant types
      // need 'refresh_token' present to ever issue one during DCR. Setting this
      // explicitly here would suppress that default (an explicit field is never
      // overwritten) and could silently prevent refresh tokens from being
      // issued, even though this class fully supports using one once present.
      response_types: ['code'],
      client_name: this._clientName,
      ...(this._scopes ? { scope: this._scopes } : {}),
    }
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (this._clientId) {
      return {
        client_id: this._clientId,
        ...(this._clientSecret ? { client_secret: this._clientSecret } : {}),
      }
    }
    const issuer = ctx?.issuer ?? (await this._lastIssuer())
    const raw = await this._store.get(this._key('client_info', issuer))
    if (!raw) return undefined
    return JSON.parse(raw) as StoredOAuthClientInformation
  }

  async saveClientInformation(
    info: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    if (this._clientId) return  // pre-registered — never overwrite with DCR response
    if (ctx?.issuer) await this._rememberIssuer(ctx.issuer)
    await this._store.set(this._key('client_info', ctx?.issuer), JSON.stringify(info))
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    // Per SEP-2352: the per-request bearer-token read (adaptOAuthProvider's
    // token() bridge) calls this with no ctx at all, so it must resolve the
    // most-recently-saved token set rather than returning undefined.
    const issuer = ctx?.issuer ?? (await this._lastIssuer())
    const raw = await this._store.get(this._key('tokens', issuer))
    if (!raw) return undefined
    return JSON.parse(raw) as StoredOAuthTokens
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    if (ctx?.issuer) await this._rememberIssuer(ctx.issuer)
    await this._store.set(this._key('tokens', ctx?.issuer), JSON.stringify(tokens))
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
    this._callbackPromise = new Promise<URLSearchParams>((resolve, reject) => {
      this._callbackResolve = resolve
      this._callbackReject = reject
    })
    // Suppress unhandled-rejection warnings — the promise is observed via Promise.race.
    this._callbackPromise.catch(() => {})
  }

  /** Resolves the pending callback with the full authorization callback params. */
  protected _resolveCallback(params: URLSearchParams): void {
    this._callbackResolve?.(params)
  }

  /** Rejects the pending callback with an error. */
  protected _rejectCallback(err: Error): void {
    this._callbackReject?.(err)
  }

  /**
   * Races the pending callback promise against a timeout and clears the
   * promise state. Subclasses reuse this and add their own teardown.
   */
  protected async _awaitCallback(timeoutMs: number): Promise<URLSearchParams> {
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
    const issuer = await this._lastIssuer()
    if (scope === 'all' || scope === 'tokens') {
      await this._store.delete(this._key('tokens', issuer))
      await this._store.delete(this._key('tokens'))  // pre-issuer-keying entries, if any
    }
    if (scope === 'all' || scope === 'client') {
      await this._store.delete(this._key('client_info', issuer))
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
   * then stops the server and resolves with the full callback `URLSearchParams`
   * (including `code` and, when present, the RFC 9207 `iss` parameter).
   *
   * Must be called after the UnauthorizedError thrown by connect() is caught.
   * Pass the result directly to the transport's `finishAuth(callbackParams)`.
   */
  async waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<URLSearchParams> {
    try {
      return await this._awaitCallback(timeoutMs)
    } finally {
      this._stopCallbackServer()
    }
  }

  private _key(type: string, issuer?: string): string {
    return issuer ? `${issuer}/${type}` : `${this._serverUrl}/${type}`
  }

  /** Storage key for the "last issuer seen for this server" pointer (SEP-2352). */
  private _issuerPointerKey(): string {
    return `${this._serverUrl}/issuer`
  }

  /**
   * Remembers the resolved authorization-server issuer for this MCP server,
   * so later no-ctx reads (e.g. the transport's per-request bearer-token read)
   * know which issuer-keyed credential set to return.
   */
  private async _rememberIssuer(issuer: string): Promise<void> {
    await this._store.set(this._issuerPointerKey(), issuer)
  }

  private async _lastIssuer(): Promise<string | undefined> {
    return (await this._store.get(this._issuerPointerKey())) ?? undefined
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
          this._callbackResolve(url.searchParams)
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

/** Token-endpoint authentication method for a shared client secret. */
export type ClientSecretAuthMethod = 'client_secret_post' | 'client_secret_basic'

/** Fields common to every {@link ClientCredentials} configuration. */
interface ClientCredentialsBaseOptions {
  tokenEndpoint: string
  clientId: string
  scope?: string
  /**
   * Persistent token store. Default: in-memory. The cache key is derived from
   * `tokenEndpoint` alone, with no client identity in it — use one store per
   * credential identity. Do not share a persistent `store` across two
   * `ClientCredentials` instances that have different `clientId`/`clientSecret`/
   * `privateKey` but the same `tokenEndpoint`; they will read and overwrite
   * each other's cached tokens.
   */
  store?: KeyValueStore
  /** How many seconds before expiry to proactively re-fetch. Default: 60. */
  refreshBufferSeconds?: number
}

/**
 * Shared-secret configuration for {@link ClientCredentials}.
 *
 * `authMethod` selects how the secret reaches the token endpoint:
 * - `client_secret_post` (default) — `client_id` and `client_secret` in the
 *   POST body. Unchanged from earlier releases.
 * - `client_secret_basic` — an RFC 6749 §2.3.1 HTTP Basic `Authorization`
 *   header. Nothing secret goes in the body.
 */
export interface ClientSecretCredentialsOptions extends ClientCredentialsBaseOptions {
  clientSecret: string
  /** Token-endpoint authentication method. Default: `client_secret_post`. */
  authMethod?: ClientSecretAuthMethod
  privateKey?: never
  algorithm?: never
}

/**
 * `private_key_jwt` configuration for {@link ClientCredentials} (RFC 7523 /
 * SEP-1046): the client proves its identity with a signed JWT `client_assertion`
 * instead of a shared secret. The assertion is signed by the SDK's own
 * `private_key_jwt` machinery — no secret is ever sent to the token endpoint.
 */
export interface PrivateKeyJwtCredentialsOptions extends ClientCredentialsBaseOptions {
  /** Signing key: a PEM (PKCS#8) string, its bytes, or a JWK object. */
  privateKey: string | Uint8Array | Record<string, unknown>
  /** JWS signing algorithm, e.g. `ES256` or `RS256`. */
  algorithm: string
  /**
   * The assertion's `aud` claim. Required — there is no safe default, because
   * this provider does no discovery and cannot learn the authorization server's
   * identity on its own. RFC 7523 §3 recommends the authorization server's
   * `issuer` identifier; some servers instead verify against the token endpoint
   * URL. Set whichever your server checks (issuer is the more common choice).
   */
  audience: string
  /** Assertion lifetime in seconds. Default: 300. */
  jwtLifetimeSeconds?: number
  /** Extra claims merged over the standard `iss`/`sub`/`aud`/`exp`/`iat`/`jti`. */
  claims?: Record<string, unknown>
  clientSecret?: never
  authMethod?: never
}

/**
 * Configuration for {@link ClientCredentials}. A discriminated union: supply
 * either a `clientSecret` (with an optional `authMethod`) or a `privateKey`
 * (with its `algorithm`) — the two are mutually exclusive and enforced at
 * compile time.
 */
export type ClientCredentialsOptions =
  | ClientSecretCredentialsOptions
  | PrivateKeyJwtCredentialsOptions

const DEFAULT_REFRESH_BUFFER_SECONDS = 60

/** Internal discriminant for the selected token-endpoint auth method. */
type TokenEndpointAuthMethod = ClientSecretAuthMethod | 'private_key_jwt'

/**
 * Builds an RFC 6749 §2.3.1 HTTP Basic `Authorization` header value. The client
 * id and secret are each percent-encoded (RFC 3986, via `encodeURIComponent` —
 * space becomes `%20`, not `+`), which a conformant §2.3.1 decoder accepts, then
 * joined with a colon and Base64-encoded.
 */
function basicAuthHeader(clientId: string, clientSecret: string): string {
  const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  return `Basic ${btoa(credentials)}`
}

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

/**
 * A persisted, single-flight token cache shared by every non-interactive token
 * provider ({@link ClientCredentials}, {@link JwtBearerAuth},
 * {@link EnterpriseManagedAuth}). It reads the store, returns a still-valid
 * token, and otherwise coalesces concurrent fetches into one call of the
 * provider's `fetcher`, normalizes the result (computing `expires_at`), and
 * persists it. Providers supply only the grant-specific network call — the
 * caching, expiry, and coalescing live here once, not per provider.
 */
class TokenCache {
  private _fetchPromise: Promise<OAuthToken> | null = null

  constructor(
    private readonly _store: KeyValueStore,
    private readonly _key: string,
    private readonly _bufferMs: number,
  ) {}

  async get(fetcher: () => Promise<OAuthToken>): Promise<OAuthToken> {
    const raw = await this._store.get(this._key)
    if (raw) {
      const normalized = normalizeToken(JSON.parse(raw) as OAuthToken)
      if (!isExpiring(normalized, this._bufferMs)) return normalized
    }
    this._fetchPromise ??= (async () => {
      const token = normalizeToken(await fetcher())
      if (!token.access_token) {
        throw new Error('token response missing access_token')
      }
      await this._store.set(this._key, JSON.stringify(token))
      return token
    })().finally(() => {
      this._fetchPromise = null
    })
    return this._fetchPromise
  }
}

export class ClientCredentials implements AsyncHeaderAuth {
  readonly kind = 'client_credentials' as const

  private readonly _tokenEndpoint: string
  private readonly _clientId: string
  private readonly _scope?: string
  private readonly _authMethod: TokenEndpointAuthMethod
  /** Set for `client_secret_post` / `client_secret_basic`. */
  private readonly _clientSecret?: string
  /**
   * Set for `private_key_jwt`. The SDK's `createPrivateKeyJwtAuth` signs the
   * assertion and stamps `client_assertion` / `client_assertion_type` onto the
   * token-request params — we reuse it verbatim instead of hand-rolling JOSE.
   */
  private readonly _addClientAssertion?: AddClientAuthentication
  private readonly _cache: TokenCache

  constructor(options: ClientCredentialsOptions) {
    this._tokenEndpoint = options.tokenEndpoint
    this._clientId = options.clientId
    this._scope = options.scope
    const store = options.store ?? new InMemoryStore()
    const bufferMs =
      (options.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000
    this._cache = new TokenCache(store, `${this._tokenEndpoint}/token`, bufferMs)

    if (options.privateKey !== undefined) {
      this._authMethod = 'private_key_jwt'
      this._addClientAssertion = createPrivateKeyJwtAuth({
        issuer: options.clientId,
        subject: options.clientId,
        privateKey: options.privateKey,
        alg: options.algorithm,
        audience: options.audience,
        lifetimeSeconds: options.jwtLifetimeSeconds,
        claims: options.claims,
      })
    } else {
      this._authMethod = options.authMethod ?? 'client_secret_post'
      this._clientSecret = options.clientSecret
    }
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this._cache.get(() => this._fetchToken())
    const type = token.token_type?.trim() || 'Bearer'
    return { Authorization: `${type} ${token.access_token}` }
  }

  private async _fetchToken(): Promise<OAuthToken> {
    const params = new URLSearchParams({ grant_type: 'client_credentials' })
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    }

    if (this._authMethod === 'private_key_jwt') {
      // private_key_jwt: the SDK signs the assertion and stamps
      // client_assertion / client_assertion_type onto the params.
      if (this._scope) params.set('scope', this._scope)
      await this._addClientAssertion!(new Headers(), params, this._tokenEndpoint)
    } else if (this._authMethod === 'client_secret_basic') {
      // client_secret_basic: credentials go in the Authorization header only.
      if (this._scope) params.set('scope', this._scope)
      headers.Authorization = basicAuthHeader(this._clientId, this._clientSecret!)
    } else {
      // client_secret_post (default): credentials in the body. Field order is
      // kept identical to earlier releases so the request stays byte-for-byte
      // the same for existing callers.
      params.set('client_id', this._clientId)
      params.set('client_secret', this._clientSecret!)
      if (this._scope) params.set('scope', this._scope)
    }

    const response = await fetch(this._tokenEndpoint, {
      method: 'POST',
      headers,
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
    return data as OAuthToken
  }
}

// ---------------------------------------------------------------------------
// JwtBearerAuth — RFC 7523 §2.1 JWT-bearer grant (SEP-1933 workload identity)
// ---------------------------------------------------------------------------

/** A workload assertion: a signed JWT string, or an (async) factory for one. */
export type AssertionSource = string | (() => string | Promise<string>)

/**
 * Configuration for {@link JwtBearerAuth}.
 *
 * The client presents a pre-issued, signed JWT (`assertion`) directly to the
 * token endpoint under `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
 * (RFC 7523 §2.1). No interactive authorization, no client secret by default —
 * this is the workload-identity-federation shape (SEP-1933): a workload proves
 * its identity with a JWT its runtime already minted (a Kubernetes projected
 * service-account token, a cloud instance-identity JWT, etc.).
 */
export interface JwtBearerOptions {
  /** The authorization server's token endpoint. */
  tokenEndpoint: string
  /**
   * The workload assertion (a signed JWT). Pass a string for a fixed assertion,
   * or a callback to mint/read a fresh one each time a token is fetched (the
   * usual case — workload JWTs are short-lived).
   */
  assertion: AssertionSource
  /** The client identifier registered for this workload. */
  clientId?: string
  /**
   * Token-endpoint client authentication. Default: `none` (public client — the
   * assertion itself is the credential, so no separate client secret is sent).
   */
  authMethod?: ClientAuthMethod
  /** Client secret, when `authMethod` is `client_secret_basic`/`_post`. */
  clientSecret?: string
  /** Requested scopes (space-separated). */
  scope?: string
  /**
   * Persistent token store. Default: in-memory. The cache key is derived from
   * `tokenEndpoint` alone, with no client identity in it — use one store per
   * credential identity. Do not share a persistent `store` across two
   * `JwtBearerAuth` instances that have different `clientId`/`assertion` but
   * the same `tokenEndpoint`; they will read and overwrite each other's
   * cached tokens.
   */
  store?: KeyValueStore
  /** How many seconds before expiry to proactively re-fetch. Default: 60. */
  refreshBufferSeconds?: number
}

export class JwtBearerAuth implements AsyncHeaderAuth {
  readonly kind = 'jwt_bearer' as const

  private readonly _tokenEndpoint: string
  private readonly _assertion: AssertionSource
  private readonly _clientId?: string
  private readonly _authMethod: ClientAuthMethod
  private readonly _clientSecret?: string
  private readonly _scope?: string
  private readonly _cache: TokenCache

  constructor(options: JwtBearerOptions) {
    this._tokenEndpoint = options.tokenEndpoint
    this._assertion = options.assertion
    this._clientId = options.clientId
    this._authMethod = options.authMethod ?? 'none'
    this._clientSecret = options.clientSecret
    this._scope = options.scope
    const store = options.store ?? new InMemoryStore()
    const bufferMs =
      (options.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000
    this._cache = new TokenCache(store, `${this._tokenEndpoint}/jwt-bearer`, bufferMs)
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this._cache.get(() => this._fetchToken())
    const type = token.token_type?.trim() || 'Bearer'
    return { Authorization: `${type} ${token.access_token}` }
  }

  private async _fetchToken(): Promise<OAuthToken> {
    const assertion =
      typeof this._assertion === 'function' ? await this._assertion() : this._assertion
    // Reuse the SDK's RFC 7523 wire helper: it POSTs
    // grant_type=jwt-bearer + assertion and applies the chosen client auth.
    // A body rewrite is needed when a scope is configured (the helper takes no
    // scope param) or when no clientId is set (the helper's public-client path
    // always writes client_id, so we drop the empty value it would emit).
    const needsRewrite = this._scope !== undefined || this._clientId === undefined
    const tokens = await exchangeJwtAuthGrant({
      tokenEndpoint: this._tokenEndpoint,
      jwtAuthGrant: assertion,
      clientId: this._clientId ?? '',
      ...(this._clientSecret ? { clientSecret: this._clientSecret } : {}),
      authMethod: this._authMethod,
      ...(needsRewrite ? { fetchFn: this._rewriteBody() } : {}),
    })
    return tokens as OAuthToken
  }

  /**
   * Wraps fetch to fix up the token-request body the SDK helper builds:
   * appends `scope` when configured (RFC 7523 §2.1 allows it alongside the
   * assertion), and drops an empty `client_id` when no client identifier is set
   * (the helper's public-client path always writes one — we send no `client_id`
   * at all rather than `client_id=`).
   */
  private _rewriteBody() {
    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = new URLSearchParams((init?.body as string) ?? '')
      if (this._scope !== undefined && !body.has('scope')) body.set('scope', this._scope)
      if (this._clientId === undefined && body.get('client_id') === '') {
        body.delete('client_id')
      }
      return fetch(url, { ...init, body: body.toString() })
    }
  }
}

// ---------------------------------------------------------------------------
// EnterpriseManagedAuth — SEP-990 token exchange + JWT-bearer grant
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link EnterpriseManagedAuth} (SEP-990, Enterprise-Managed
 * Authorization / Cross-App Access).
 *
 * The flow is two hops, both stable RFCs:
 *  1. **Token exchange** (RFC 8693) at the enterprise IdP: exchange the user's
 *     OpenID Connect ID token for an *identity assertion JWT authorization
 *     grant* (ID-JAG) scoped to the target MCP server.
 *  2. **JWT-bearer grant** (RFC 7523) at the MCP server's authorization server:
 *     present the ID-JAG under `grant_type=jwt-bearer` to obtain the access
 *     token.
 */
export interface EnterpriseManagedOptions {
  /** The MCP server's authorization-server token endpoint (step 2). */
  tokenEndpoint: string
  /** The MCP client identifier registered with the authorization server. */
  clientId: string
  /** The MCP client secret (default client auth is `client_secret_basic`). */
  clientSecret?: string
  /** Client-authentication method for step 2. Default: `client_secret_basic`. */
  authMethod?: ClientAuthMethod
  /**
   * The ID-JAG audience — the target authorization server's identifier. The
   * authorization server verifies the ID-JAG `aud` against this.
   */
  audience: string
  /**
   * The protected-resource identifier of the target MCP server (RFC 9728). The
   * authorization server verifies the ID-JAG `resource` against this.
   */
  resource: string
  /** The enterprise IdP's token endpoint (step 1). */
  idpTokenEndpoint: string
  /** The client identifier registered with the IdP for token exchange. */
  idpClientId: string
  /** The client secret for the IdP token exchange, if the IdP requires one. */
  idpClientSecret?: string
  /**
   * The user's OpenID Connect ID token (the `subject_token` of the exchange).
   * Pass a string, or a callback to read a fresh one each fetch.
   */
  idToken: AssertionSource
  /** Requested scopes (space-separated). */
  scope?: string
  /**
   * Persistent token store. Default: in-memory. The cache key is derived from
   * `tokenEndpoint` alone, with no client identity in it — use one store per
   * credential identity. Do not share a persistent `store` across two
   * `EnterpriseManagedAuth` instances that have different `clientId`/`idToken`
   * but the same `tokenEndpoint`; they will read and overwrite each other's
   * cached tokens.
   */
  store?: KeyValueStore
  /** How many seconds before expiry to proactively re-fetch. Default: 60. */
  refreshBufferSeconds?: number
}

export class EnterpriseManagedAuth implements AsyncHeaderAuth {
  readonly kind = 'enterprise_managed' as const

  private readonly _options: EnterpriseManagedOptions
  private readonly _cache: TokenCache

  constructor(options: EnterpriseManagedOptions) {
    this._options = options
    const store = options.store ?? new InMemoryStore()
    const bufferMs =
      (options.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000
    this._cache = new TokenCache(store, `${options.tokenEndpoint}/enterprise-managed`, bufferMs)
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this._cache.get(() => this._fetchToken())
    const type = token.token_type?.trim() || 'Bearer'
    return { Authorization: `${type} ${token.access_token}` }
  }

  private async _fetchToken(): Promise<OAuthToken> {
    const o = this._options
    const idToken = typeof o.idToken === 'function' ? await o.idToken() : o.idToken
    // Step 1 — RFC 8693 token exchange at the IdP: ID token -> ID-JAG.
    const grant = await requestJwtAuthorizationGrant({
      tokenEndpoint: o.idpTokenEndpoint,
      audience: o.audience,
      resource: o.resource,
      idToken,
      clientId: o.idpClientId,
      ...(o.idpClientSecret ? { clientSecret: o.idpClientSecret } : {}),
      ...(o.scope ? { scope: o.scope } : {}),
    })
    // Step 2 — RFC 7523 JWT-bearer grant at the MCP authorization server:
    // present the ID-JAG for the access token.
    const tokens = await exchangeJwtAuthGrant({
      tokenEndpoint: o.tokenEndpoint,
      jwtAuthGrant: grant.jwtAuthGrant,
      clientId: o.clientId,
      ...(o.clientSecret ? { clientSecret: o.clientSecret } : {}),
      authMethod: o.authMethod ?? 'client_secret_basic',
    })
    return tokens as OAuthToken
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
