import type { AuthCheck } from './auth/authorization'
import type { ResourceUiMeta } from './apps/types'
import { isInputRequiredResult } from './mrtr'
import type { InputRequiredResult } from './mrtr'

export interface ResourceAnnotations {
  /** Intended audience(s) — 'user', 'assistant', or both. */
  audience?: Array<'user' | 'assistant'>
  /** Importance hint from 0 (least) to 1 (most). */
  priority?: number
  /** ISO 8601 timestamp of last modification. */
  lastModified?: string
}

export interface ResourceConfig {
  /** Static URI (e.g. `file://readme`) or RFC 6570 template (e.g. `user://{id}`). */
  uri: string
  /** Programmatic identifier. Defaults to the uri. */
  name?: string
  /** Human-readable display name shown in UIs. Defaults to `name`. */
  title?: string
  description?: string
  /** MIME type of the resource content. Defaults to 'text/plain' for strings, 'application/octet-stream' for binary. */
  mimeType?: string
  /**
   * Size of the resource content in bytes, if known.
   * Only meaningful for static resources; ignored for URI templates.
   */
  size?: number
  /** Behavioral hints for clients. */
  annotations?: ResourceAnnotations
  /** Execution timeout in milliseconds. No timeout by default. */
  timeout?: number
  /** When true the resource is hidden from list responses and cannot be read. */
  disabled?: boolean
  /** Arbitrary tags for server-side filtering. */
  tags?: string[]
  auth?: AuthCheck
  /** Apps extension metadata. Included in _meta.ui in resources/list for UI-capable clients. */
  ui?: ResourceUiMeta
}

/**
 * Escape hatch for full control over resource response content.
 * Return this from a resource handler to specify content directly.
 */
export class ResourceResult {
  constructor(
    readonly contents: Array<{
      uri: string
      mimeType?: string
      text?: string
      blob?: string
    }>,
  ) {}
}

type ResourceContent =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string }

/**
 * Converts a resource handler's return value into the MCP ReadResourceResult shape.
 *
 * - string              → text content
 * - Buffer / Uint8Array → base64 blob content
 * - object / array      → JSON-serialised text with mimeType application/json
 * - ResourceResult      → passthrough
 * - null / undefined    → empty text content
 */
export function convertResourceResult(
  value: unknown,
  uri: string,
  mimeType?: string,
): { contents: ResourceContent[] } | InputRequiredResult {
  // Multi-round-trip escape hatch (protocol revision 2026-07-28) — see tool.ts's
  // convertResult for the same pattern applied to tools/call.
  if (isInputRequiredResult(value)) {
    return value
  }
  if (value instanceof ResourceResult) {
    return { contents: value.contents as ResourceContent[] }
  }
  if (value instanceof Buffer || value instanceof Uint8Array) {
    return {
      contents: [
        {
          uri,
          mimeType: mimeType ?? 'application/octet-stream',
          blob: Buffer.from(value).toString('base64'),
        },
      ],
    }
  }
  if (value === null || value === undefined) {
    return { contents: [{ uri, mimeType: mimeType ?? 'text/plain', text: '' }] }
  }
  if (typeof value === 'object') {
    return {
      contents: [{ uri, mimeType: mimeType ?? 'application/json', text: JSON.stringify(value) }],
    }
  }
  // string, number, boolean
  return { contents: [{ uri, mimeType: mimeType ?? 'text/plain', text: String(value) }] }
}

/** Returns true if the URI string contains RFC 6570 template expressions. */
export function isUriTemplate(uri: string): boolean {
  return uri.includes('{')
}

/**
 * Matches a concrete URI against an RFC 6570 URI template and returns the
 * extracted parameter values, or null if the URI does not match the template.
 *
 * Supports:
 *   - Simple path params:   {id}    → matches a single path segment
 *   - Wildcard path params: {path*} → matches multiple segments (including '/')
 *   - Query params:         {?q,lang} → extracted from the query string
 */
export function matchTemplate(
  uriTemplate: string,
  uri: string,
): Record<string, string> | null {
  // Split URI into base and query string
  const qIdx = uri.indexOf('?')
  const baseUri = qIdx >= 0 ? uri.slice(0, qIdx) : uri
  const queryString = qIdx >= 0 ? uri.slice(qIdx + 1) : ''

  // Pull out query param names from {?...} expressions and strip them from the template
  const queryParamNames: string[] = []
  const baseTemplate = uriTemplate.replace(/\{[?][^}]+\}/g, (match) => {
    match
      .slice(2, -1)
      .split(',')
      .map((s) => s.trim())
      .forEach((n) => queryParamNames.push(n))
    return ''
  })

  // Build a regex from the base template, collecting path param names
  const names: string[] = []
  const segments = baseTemplate.split(/(\{[^}]+\})/g)
  let pattern = '^'
  for (const seg of segments) {
    if (seg.startsWith('{') && seg.endsWith('}')) {
      const inner = seg.slice(1, -1)
      if (inner.endsWith('*')) {
        names.push(inner.slice(0, -1))
        pattern += '(.+)'
      } else {
        names.push(inner)
        pattern += '([^/?]+)'
      }
    } else if (seg) {
      // Escape regex metacharacters in literal parts
      pattern += seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  pattern += '$'

  const pathMatch = baseUri.match(new RegExp(pattern))
  if (!pathMatch) return null

  const params: Record<string, string> = {}
  names.forEach((name, i) => {
    params[name] = decodeURIComponent(pathMatch[i + 1])
  })

  // Extract query parameters
  if (queryParamNames.length > 0 && queryString) {
    const sp = new URLSearchParams(queryString)
    for (const name of queryParamNames) {
      const val = sp.get(name)
      if (val !== null) params[name] = val
    }
  }

  return params
}
