export const UI_EXTENSION_KEY = 'io.modelcontextprotocol/ui'
export const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

/**
 * Checks whether a client has declared MCP Apps support with a `mimeTypes` list
 * that includes the profile fastmcp serves (`UI_RESOURCE_MIME_TYPE`).
 *
 * SEP-1865's Client<>Server Capability Negotiation section requires the client to
 * declare `mimeTypes` (REQUIRED) as the *value* of its `io.modelcontextprotocol/ui`
 * extension entry, and directs servers to check it (the SDK's own
 * `getUiCapability`/`mimeTypes.includes(RESOURCE_MIME_TYPE)` pattern) before
 * registering UI-enabled tools — a bare presence check on the extension key is not
 * sufficient. Request handlers gate through {@link shouldServeUi}, which adds the
 * unknown-capabilities case.
 */
export function isUiCapable(
  clientCapabilities: { extensions?: Record<string, unknown> } | undefined,
): boolean {
  const uiCapability = clientCapabilities?.extensions?.[UI_EXTENSION_KEY] as
    | { mimeTypes?: string[] }
    | undefined
  return !!uiCapability?.mimeTypes?.includes(UI_RESOURCE_MIME_TYPE)
}

/**
 * Decides whether a request handler serves MCP Apps metadata and the full tool
 * result. Gates `tools/list`, `tools/call`, `resources/list` and `resources/read`.
 *
 * `undefined` capabilities mean the server never saw them. That happens only on
 * the stateless 2025-era HTTP path, where each request runs on a fresh server
 * instance and only `initialize` carries capabilities. That `initialize` response
 * already advertised the extension, so withholding UI here would make the
 * advertisement false. Known capabilities that lack the app profile close the gate.
 */
export function shouldServeUi(
  clientCapabilities: { extensions?: Record<string, unknown> } | undefined,
): boolean {
  return clientCapabilities === undefined || isUiCapable(clientCapabilities)
}

export type Visibility = 'model' | 'app'

export interface CspPolicy {
  connectDomains?: string[]
  /** Covers img-src, script-src, style-src, font-src, media-src. */
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

export interface UiToolMeta {
  /** Explicit resource URI. Auto-derived from tool name when omitted. */
  resourceUri?: string
  /**
   * Who can see and call this tool. Defaults to `['model', 'app']` per SEP-1865
   * (visible to the model, and callable by the app served from this same
   * connection) when omitted.
   */
  visibility?: Visibility[]
}

export interface BrowserPermissions {
  camera?: Record<string, never>
  microphone?: Record<string, never>
  geolocation?: Record<string, never>
  clipboardWrite?: Record<string, never>
}

export interface ResourceUiMeta {
  csp?: CspPolicy
  permissions?: BrowserPermissions
  domain?: string
  prefersBorder?: boolean
}
