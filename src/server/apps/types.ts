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
 * sufficient. Used for both `tools/list` UI-meta inclusion and the `tools/call`
 * graceful-degradation check.
 */
export function isUiCapable(
  clientCapabilities: { extensions?: Record<string, unknown> } | undefined,
): boolean {
  const uiCapability = clientCapabilities?.extensions?.[UI_EXTENSION_KEY] as
    | { mimeTypes?: string[] }
    | undefined
  return !!uiCapability?.mimeTypes?.includes(UI_RESOURCE_MIME_TYPE)
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
