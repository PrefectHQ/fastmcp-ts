export const UI_EXTENSION_KEY = 'io.modelcontextprotocol/ui'
export const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

export type Visibility = 'model' | 'app'

export interface CspPolicy {
  connectDomains?: string[]
  scriptSrc?: string[]
  imgSrc?: string[]
}

export interface UiToolMeta {
  /** Explicit resource URI. Auto-derived from tool name when omitted. */
  resourceUri?: string
  /** Who can see this tool. Defaults to ['model']. */
  visibility?: Visibility[]
}

export interface ResourceUiMeta {
  csp?: CspPolicy
  permissions?: string[]
  domain?: string
  prefersBorder?: boolean
}
