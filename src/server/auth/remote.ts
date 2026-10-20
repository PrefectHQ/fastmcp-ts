import {
  getOAuthProtectedResourceMetadataUrl,
  type OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/server'
import type { TokenVerifier, RequestVerifier } from './types'
import { isRequestVerifier } from './types'

/** Options for {@link remoteAuth}. */
export interface RemoteAuthOptions<V extends TokenVerifier | RequestVerifier> {
  /** Verifier that checks each request's credentials, such as `jwtVerifier(...)`. */
  verifier: V
  /** Issuer URLs of the authorization servers that mint tokens for this server. */
  authorizationServers: Array<string | URL>
  /** Public URL clients use to reach this server, without the MCP path. */
  baseUrl: string | URL
  /** Scopes to advertise in the metadata document and in 401 challenges. */
  scopesSupported?: string[]
  /** Human-readable name of this server, shown by some clients. */
  resourceName?: string
  /** URL of documentation for this server. */
  resourceDocumentation?: string | URL
}

/** Validated protected-resource settings that `run()` serves as metadata. */
export interface ProtectedResourceConfig {
  readonly baseUrl: URL
  readonly authorizationServers: readonly string[]
  readonly scopesSupported?: readonly string[]
  readonly resourceName?: string
  readonly resourceDocumentation?: string
}

/** A verifier that also carries {@link ProtectedResourceConfig}. */
export type RemoteAuthProvider<V extends TokenVerifier | RequestVerifier> = V & {
  readonly protectedResource: ProtectedResourceConfig
}

/** Inputs for {@link bearerChallenge}. */
export interface BearerChallengeConfig {
  resourceMetadataUrl: string
  scopes?: readonly string[]
}

// RFC 6749 section 3.3 scope-token: printable ASCII except space, '"' and '\'.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/

function parseHttpUrl(value: string | URL, option: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`remoteAuth: ${option} must be a valid URL, got "${String(value)}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`remoteAuth: ${option} must use http or https, got "${String(value)}"`)
  }
  return url
}

/**
 * Make this server an OAuth resource server for an external authorization
 * server. Pass the result to `FastMCPOptions.auth`.
 *
 * Use it when another service issues the tokens, such as Auth0, Keycloak or
 * Okta, and this server only verifies them. `verifier` checks each request, as
 * with `jwtVerifier` or `introspectionVerifier`. `remoteAuth` adds the
 * discovery information that lets MCP clients find the authorization server on
 * their own.
 *
 * The resource URL is `baseUrl` joined with the path given to `run()`. For a
 * `baseUrl` of `https://mcp.example.com` and the default path `/mcp`, the
 * resource is `https://mcp.example.com/mcp`. Set `baseUrl` to the public URL
 * that clients use, such as the address of your reverse proxy. A wrong value
 * makes the advertised resource differ from the URL clients call.
 *
 * Over HTTP the server then serves the RFC 9728 metadata document at
 * `/.well-known/oauth-protected-resource` followed by the MCP path. Each 401
 * response also carries a `WWW-Authenticate: Bearer` challenge whose
 * `resource_metadata` parameter points to that document.
 *
 * If you set both this and `oauth`, `oauth` takes precedence.
 *
 * @example
 * ```ts
 * const mcp = new FastMCP({
 *   name: 'my-server',
 *   auth: remoteAuth({
 *     verifier: jwtVerifier({ jwksUri: 'https://auth.example.com/.well-known/jwks.json' }),
 *     authorizationServers: ['https://auth.example.com'],
 *     baseUrl: 'https://mcp.example.com',
 *   }),
 * })
 * ```
 */
export function remoteAuth(options: RemoteAuthOptions<TokenVerifier>): RemoteAuthProvider<TokenVerifier>
export function remoteAuth(
  options: RemoteAuthOptions<RequestVerifier>,
): RemoteAuthProvider<RequestVerifier>
export function remoteAuth(
  options: RemoteAuthOptions<TokenVerifier | RequestVerifier>,
): RemoteAuthProvider<TokenVerifier | RequestVerifier> {
  const { verifier } = options

  const baseUrl = parseHttpUrl(options.baseUrl, 'baseUrl')
  if (baseUrl.search !== '' || baseUrl.hash !== '') {
    throw new Error('remoteAuth: baseUrl must not have a query string or fragment')
  }

  if (options.authorizationServers.length === 0) {
    throw new Error('remoteAuth: authorizationServers must contain at least one entry')
  }
  const authorizationServers = options.authorizationServers.map((entry) => {
    const url = parseHttpUrl(entry, 'authorizationServers entry')
    return typeof entry === 'string' ? entry : url.href
  })

  for (const scope of options.scopesSupported ?? []) {
    if (!SCOPE_TOKEN.test(scope)) {
      throw new Error(
        `remoteAuth: scopesSupported entry "${scope}" must not be empty or contain spaces, quotes or backslashes`,
      )
    }
  }

  let resourceDocumentation: string | undefined
  if (options.resourceDocumentation !== undefined) {
    try {
      resourceDocumentation = new URL(options.resourceDocumentation).href
    } catch {
      throw new Error(
        `remoteAuth: resourceDocumentation must be a valid URL, got "${String(options.resourceDocumentation)}"`,
      )
    }
  }

  const protectedResource: ProtectedResourceConfig = {
    baseUrl,
    authorizationServers,
    ...(options.scopesSupported && { scopesSupported: [...options.scopesSupported] }),
    ...(options.resourceName !== undefined && { resourceName: options.resourceName }),
    ...(resourceDocumentation !== undefined && { resourceDocumentation }),
  }

  // Delegate through one method so class-based verifiers keep `this`, and so
  // the result is classified by that single method (see `isRequestVerifier`).
  if (isRequestVerifier(verifier)) {
    return { verifyRequest: (request) => verifier.verifyRequest(request), protectedResource }
  }
  return { verify: (token) => verifier.verify(token), protectedResource }
}

/** Read the config that `remoteAuth` attached to a verifier, if any. */
export function getProtectedResource(
  auth: TokenVerifier | RequestVerifier | undefined,
): ProtectedResourceConfig | undefined {
  return (auth as { protectedResource?: ProtectedResourceConfig } | undefined)?.protectedResource
}

/** Join the public base URL and the MCP path into the resource URL. */
export function resolveResourceUrl(baseUrl: URL, mcpPath: string): URL {
  const base = baseUrl.href.replace(/\/+$/, '')
  return new URL(`${base}/${mcpPath.replace(/^\/+/, '')}`)
}

/** Compute the metadata route path, its public URL, and the document to serve. */
export function protectedResourceRoute(
  config: ProtectedResourceConfig,
  mcpPath: string,
): { path: string; metadataUrl: string; metadata: OAuthProtectedResourceMetadata } {
  const resourceUrl = resolveResourceUrl(config.baseUrl, mcpPath)
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl)
  return {
    path: new URL(metadataUrl).pathname,
    metadataUrl,
    metadata: {
      resource: resourceUrl.href,
      authorization_servers: [...config.authorizationServers],
      ...(config.scopesSupported && { scopes_supported: [...config.scopesSupported] }),
      bearer_methods_supported: ['header'],
      ...(config.resourceName !== undefined && { resource_name: config.resourceName }),
      ...(config.resourceDocumentation !== undefined && {
        resource_documentation: config.resourceDocumentation,
      }),
    },
  }
}

/** Build the `WWW-Authenticate` value for a 401 response (RFC 6750, RFC 9728). */
export function bearerChallenge(config: BearerChallengeConfig, error?: 'invalid_token'): string {
  const parts = ['realm="mcp"']
  if (error) parts.push(`error="${error}"`)
  if (config.scopes && config.scopes.length > 0) parts.push(`scope="${config.scopes.join(' ')}"`)
  parts.push(`resource_metadata="${config.resourceMetadataUrl}"`)
  return `Bearer ${parts.join(', ')}`
}
