/**
 * HTTP execution for generated components.
 *
 * Port of Python FastMCP's `OpenAPITool.run` / `OpenAPIResource.read`
 * (`fastmcp.server.providers.openapi.components`): bare fetch with a timeout,
 * Python-compatible error messages (they surface as tool errors, so clients
 * may match on them), JSON responses as structuredContent with the
 * `x-fastmcp-wrap-result` unwrap applied, non-JSON as text.
 */

import { ToolResult } from '../tool'
import { ResourceResult } from '../resource'
import type { HTTPRoute, JsonSchema } from './types'
import { buildRequest } from './director'
import { isPlainObject, truthy } from './internal'

export const DEFAULT_TIMEOUT_MS = 30_000

/** HTTP client configuration for a generated OpenAPI server. */
export interface OpenAPIClientOptions {
  /**
   * Base URL for requests. Defaults to the spec's first `servers` entry
   * (with server variables filled from their defaults). Required when the
   * spec has no absolute server URL.
   */
  baseUrl?: string
  /** Default headers sent on every request. Request-specific headers win. */
  headers?: Record<string, string>
  /** Async header provider, resolved per request (e.g. a token refresher). */
  auth?: { getHeaders(): Promise<Record<string, string>> }
  /** Custom fetch implementation. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout in milliseconds. Default 30 000. */
  timeoutMs?: number
}

/** @internal Resolved client with all defaults applied. */
export interface ResolvedClient {
  baseUrl: string
  headers: Record<string, string>
  auth?: { getHeaders(): Promise<Record<string, string>> }
  fetch: typeof globalThis.fetch
  timeoutMs: number
}

/** Substitute server variables with their defaults: `{region}` → `us-east-1`. */
function fillServerVariables(url: string, variables: unknown): string {
  if (!isPlainObject(variables)) return url
  let filled = url
  for (const [name, variable] of Object.entries(variables)) {
    const fallback = isPlainObject(variable) ? variable.default : undefined
    filled = filled.split(`{${name}}`).join(typeof fallback === 'string' ? fallback : '')
  }
  return filled
}

/** @internal Resolve client options against the spec's servers entry. */
export function resolveClient(
  options: OpenAPIClientOptions,
  spec: Record<string, unknown>,
): ResolvedClient {
  let baseUrl = options.baseUrl
  if (baseUrl === undefined) {
    const servers = spec.servers
    const first = Array.isArray(servers) ? servers[0] : undefined
    const serverUrl = isPlainObject(first) && typeof first.url === 'string' ? first.url : undefined
    if (serverUrl === undefined) {
      throw new Error(
        "No server URL found in OpenAPI spec. Either add a 'servers' entry to the " +
          'spec or provide client.baseUrl explicitly.',
      )
    }
    baseUrl = fillServerVariables(serverUrl, first?.variables)
  }
  try {
    new URL(baseUrl)
  } catch {
    throw new Error(
      `OpenAPI base URL must be absolute, got '${baseUrl}'. Provide client.baseUrl explicitly.`,
    )
  }

  return {
    baseUrl,
    headers: options.headers ?? {},
    ...(options.auth !== undefined ? { auth: options.auth } : {}),
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}

async function sendRequest(
  client: ResolvedClient,
  route: HTTPRoute,
  args: Record<string, unknown>,
): Promise<Response> {
  let url: string
  let init: RequestInit
  try {
    const directed = buildRequest(route, args, client.baseUrl)
    const authHeaders = client.auth ? await client.auth.getHeaders() : {}
    // Client defaults merge under auth headers; directed headers win over
    // both. HTTP header names are case-insensitive, so merge on lowercase
    // keys — otherwise a parameter named X-Trace would ride ALONGSIDE a
    // default x-trace instead of replacing it.
    const headers: Record<string, string> = {}
    for (const source of [client.headers, authHeaders, directed.headers]) {
      for (const [name, value] of Object.entries(source)) {
        headers[name.toLowerCase()] = value
      }
    }
    url = directed.url
    init = {
      method: directed.method,
      headers,
      ...(directed.body !== undefined ? { body: directed.body } : {}),
      signal: AbortSignal.timeout(client.timeoutMs),
    }
  } catch (error) {
    const e = error as Error
    throw new Error(
      `Error building request for ${route.method.toUpperCase()} ${route.path}: ${e.name}: ${e.message}`,
    )
  }

  let response: Response
  try {
    response = await client.fetch(url, init)
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`HTTP request timed out (${(error as Error).name})`)
    }
    const e = error as Error
    throw new Error(`Request error (${e.name}): ${e.message}`)
  }

  if (!response.ok) {
    let message = `HTTP error ${response.status}: ${response.statusText}`
    const text = await response.text().catch(() => '')
    if (text) message += ` - ${text}`
    throw new Error(message)
  }

  return response
}

/** Execute a tool call: send the HTTP request and convert the response. */
export async function runToolRequest(
  client: ResolvedClient,
  route: HTTPRoute,
  args: Record<string, unknown>,
  outputSchema: JsonSchema | null | undefined,
): Promise<ToolResult> {
  const response = await sendRequest(client, route, args)
  const text = await response.text()

  let result: unknown
  try {
    result = JSON.parse(text)
  } catch {
    // Not JSON: return the raw text.
    return new ToolResult({ content: [{ type: 'text', text }] })
  }

  let structured: unknown
  if (outputSchema !== null && outputSchema !== undefined) {
    structured = truthy(outputSchema['x-fastmcp-wrap-result']) ? { result } : result
  } else if (!isPlainObject(result)) {
    structured = { result }
  } else {
    structured = result
  }
  // structuredContent must be a plain object on the wire; wrap anything that
  // slipped through (e.g. a backend returning an array against an object schema).
  if (!isPlainObject(structured)) {
    structured = { result: structured }
  }

  return new ToolResult({
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured as Record<string, unknown>,
  })
}

/** Execute a resource read: send the HTTP request and convert the response. */
export async function readResourceRequest(
  client: ResolvedClient,
  route: HTTPRoute,
  args: Record<string, unknown>,
  uri: string,
  mimeType: string,
): Promise<ResourceResult> {
  const response = await sendRequest(client, route, args)
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.includes('application/json')) {
    const result: unknown = JSON.parse(await response.text())
    return new ResourceResult([
      { uri, mimeType: 'application/json', text: JSON.stringify(result) },
    ])
  }
  if (contentType.includes('text/') || contentType.includes('application/xml')) {
    return new ResourceResult([{ uri, mimeType, text: await response.text() }])
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  return new ResourceResult([{ uri, mimeType, blob: bytes.toString('base64') }])
}
