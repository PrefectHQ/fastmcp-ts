export const UI_EXTENSION_KEY = 'io.modelcontextprotocol/ui'
export const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

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
  /** Who can see this tool. Defaults to ['model']. */
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
