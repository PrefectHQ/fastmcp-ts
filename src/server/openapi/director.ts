/**
 * Request building: flat MCP tool arguments → a concrete HTTP request.
 *
 * Port of Python FastMCP's `fastmcp.utilities.openapi.director`
 * (RequestDirector). Handles un-flattening via the parameter map, OpenAPI
 * query style/explode serialization, strict path-parameter percent-encoding
 * (everything encoded, plus `.` → `%2E`), and request-body dispatch on the
 * FIRST declared content type.
 */

import type { HTTPRoute, ParameterInfo } from './types'
import { isPlainObject, warn } from './internal'

/** A fully built HTTP request, ready to hand to fetch. */
export interface DirectedRequest {
  method: string
  /** Absolute URL including any query string. */
  url: string
  headers: Record<string, string>
  body?: string | URLSearchParams | FormData
}

/**
 * Query-string representation of a scalar. Booleans are lowercased to match
 * JSON/OpenAPI conventions (true/false).
 */
function queryScalarToStr(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** Delimiter per OpenAPI style when explode=false. */
const STYLE_DELIMITERS: Record<string, string> = {
  form: ',',
  spaceDelimited: ' ',
  pipeDelimited: '|',
}

interface UnflattenedArguments {
  pathParams: Record<string, unknown>
  queryParams: Record<string, unknown>
  headerParams: Record<string, unknown>
  cookieParams: Record<string, unknown>
  body: unknown
}

/** Map flat arguments back to their OpenAPI locations via the parameter map. */
function unflattenArguments(route: HTTPRoute, flatArgs: Record<string, unknown>): UnflattenedArguments {
  const pathParams: Record<string, unknown> = {}
  const queryParams: Record<string, unknown> = {}
  const headerParams: Record<string, unknown> = {}
  const cookieParams: Record<string, unknown> = {}
  const bodyProps: Record<string, unknown> = {}

  const buckets: Record<string, Record<string, unknown>> = {
    path: pathParams,
    query: queryParams,
    header: headerParams,
    cookie: cookieParams,
    body: bodyProps,
  }

  if (Object.keys(route.parameterMap).length > 0) {
    for (const [argName, value] of Object.entries(flatArgs)) {
      if (value === null || value === undefined) continue // optional parameter omitted

      const mapping = route.parameterMap[argName]
      if (mapping === undefined) {
        warn(`Argument '${argName}' not found in parameter map for ${route.operationId ?? route.path}`)
        continue
      }
      buckets[mapping.location][mapping.openapiName] = value
    }
  } else {
    // Fallback when pre-calculation failed: suffix parsing, then declared
    // parameter locations, else body.
    const paramLocations = new Map(route.parameters.map((p) => [p.name, p.location]))

    for (const [argName, value] of Object.entries(flatArgs)) {
      if (value === null || value === undefined) continue

      const suffixIdx = argName.lastIndexOf('__')
      if (suffixIdx !== -1) {
        const baseName = argName.slice(0, suffixIdx)
        const location = argName.slice(suffixIdx + 2)
        if (location in buckets && location !== 'body') {
          buckets[location][baseName] = value
          continue
        }
      }

      const location = paramLocations.get(argName)
      if (location !== undefined) {
        buckets[location][argName] = value
      } else {
        bodyProps[argName] = value
      }
    }
  }

  // Body construction: an object-typed OR object-like (has properties, e.g.
  // allOf-merged) body schema keeps the property map; a genuine non-object
  // schema with exactly one property sends the value directly.
  let body: unknown
  if (Object.keys(bodyProps).length > 0) {
    const contentSchema = route.requestBody?.contentSchema
    if (contentSchema && Object.keys(contentSchema).length > 0) {
      const contentType = Object.keys(contentSchema)[0]
      const bodySchema = contentSchema[contentType]

      if (
        isPlainObject(bodySchema) &&
        (bodySchema.type === 'object' || isPlainObject(bodySchema.properties))
      ) {
        body = bodyProps
      } else if (Object.keys(bodyProps).length === 1) {
        body = Object.values(bodyProps)[0]
      } else {
        body = bodyProps
      }
    } else {
      body = bodyProps
    }
  }

  return { pathParams, queryParams, headerParams, cookieParams, body }
}

/**
 * Serialize query values per their OpenAPI style/explode settings. Exploded
 * arrays stay arrays (the key repeats in the query string); explode=false
 * joins with the style's delimiter; exploded objects fan out into separate
 * keys (bare property names for form style, `key[prop]` for deepObject).
 */
function serializeQueryParams(
  route: HTTPRoute,
  queryParams: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(queryParams).length === 0) return queryParams

  const paramLookup = new Map<string, ParameterInfo>(
    route.parameters.filter((p) => p.location === 'query').map((p) => [p.name, p]),
  )

  const serialized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(queryParams)) {
    const paramInfo = paramLookup.get(key)
    if (paramInfo !== undefined) {
      const explode = paramInfo.explode ?? true
      if (isPlainObject(value)) {
        if (Object.keys(value).length === 0) continue
        if (explode) {
          for (const [propKey, propValue] of Object.entries(value)) {
            const propertyName =
              paramInfo.style === 'deepObject'
                ? `${key}[${queryScalarToStr(propKey)}]`
                : queryScalarToStr(propKey)
            serialized[propertyName] = queryScalarToStr(propValue)
          }
        } else {
          const delimiter = STYLE_DELIMITERS[paramInfo.style ?? 'form'] ?? ','
          // form,explode=false on objects: key,value pairs (R,100,G,200).
          const parts: string[] = []
          for (const [propKey, propValue] of Object.entries(value)) {
            parts.push(queryScalarToStr(propKey), queryScalarToStr(propValue))
          }
          serialized[key] = parts.join(delimiter)
        }
        continue
      }
      if (!explode && Array.isArray(value)) {
        if (value.length === 0) continue
        const delimiter = STYLE_DELIMITERS[paramInfo.style ?? 'form'] ?? ','
        serialized[key] = value.map(queryScalarToStr).join(delimiter)
        continue
      }
    }
    serialized[key] = value
  }
  return serialized
}

/**
 * Percent-encode a path parameter value. Everything outside [A-Za-z0-9_~-]
 * is encoded (Python `quote(safe="")` parity), and `.` becomes `%2E` so a
 * crafted value can never traverse the path.
 */
function quotePathValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\./g, '%2E')
}

/** Substitute path parameters into the template and join with the base URL. */
function buildUrl(pathTemplate: string, pathParams: Record<string, unknown>, baseUrl: string): string {
  let urlPath = pathTemplate
  for (const [paramName, paramValue] of Object.entries(pathParams)) {
    const placeholder = `{${paramName}}`
    if (urlPath.includes(placeholder)) {
      urlPath = urlPath.split(placeholder).join(quotePathValue(String(paramValue)))
    }
  }
  const base = `${baseUrl.replace(/\/+$/, '')}/`
  return new URL(urlPath.replace(/^\/+/, ''), base).toString()
}

/**
 * Build the complete HTTP request for a route from flat tool arguments,
 * handling all OpenAPI serialization rules.
 */
export function buildRequest(
  route: HTTPRoute,
  flatArgs: Record<string, unknown>,
  baseUrl: string,
): DirectedRequest {
  const { pathParams, queryParams, headerParams, cookieParams, body } = unflattenArguments(
    route,
    flatArgs,
  )

  const serializedQuery = serializeQueryParams(route, queryParams)

  const url = new URL(buildUrl(route.path, pathParams, baseUrl))
  for (const [key, value] of Object.entries(serializedQuery)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, queryScalarToStr(item))
    } else {
      url.searchParams.append(key, queryScalarToStr(value))
    }
  }

  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(headerParams)) {
    headers[key] = queryScalarToStr(value)
  }
  const cookiePairs = Object.entries(cookieParams).map(
    ([key, value]) => `${key}=${queryScalarToStr(value)}`,
  )
  if (cookiePairs.length > 0) {
    headers.cookie = cookiePairs.join('; ')
  }

  // Declared content type from the spec: raw value for the outgoing header
  // (preserves parameters like charset), normalized for dispatch matching.
  let rawContentType: string | undefined
  let declaredContentType: string | undefined
  const contentSchema = route.requestBody?.contentSchema
  if (contentSchema && Object.keys(contentSchema).length > 0) {
    rawContentType = Object.keys(contentSchema)[0]
    declaredContentType = rawContentType.split(';')[0].trim().toLowerCase()
  }

  let requestBody: DirectedRequest['body']
  if (body !== null && body !== undefined) {
    if (declaredContentType === 'multipart/form-data' && isPlainObject(body)) {
      const form = new FormData()
      for (const [key, value] of Object.entries(body)) {
        if (value instanceof Uint8Array) {
          form.append(key, new Blob([value as BlobPart]))
        } else {
          form.append(key, queryScalarToStr(value))
        }
      }
      requestBody = form
      // fetch sets the multipart boundary header itself.
    } else if (declaredContentType === 'application/x-www-form-urlencoded' && isPlainObject(body)) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(body)) {
        params.append(key, queryScalarToStr(value))
      }
      requestBody = params
    } else if (isPlainObject(body) || Array.isArray(body)) {
      requestBody = JSON.stringify(body)
      // JSON-compatible types like application/json-patch+json keep their
      // declared content type; everything else is plain application/json.
      headers['content-type'] =
        declaredContentType !== undefined &&
        declaredContentType !== 'application/json' &&
        declaredContentType.includes('json')
          ? (rawContentType as string)
          : 'application/json'
    } else {
      requestBody = String(body)
      if (rawContentType !== undefined) {
        headers['content-type'] = rawContentType
      }
    }
  }

  return {
    method: route.method.toUpperCase(),
    url: url.toString(),
    headers,
    ...(requestBody !== undefined ? { body: requestBody } : {}),
  }
}

/** @internal Exported for the resource template path-argument reverse lookup. */
export function pathArgumentName(route: HTTPRoute, parameterName: string): string {
  for (const [argumentName, mapping] of Object.entries(route.parameterMap)) {
    if (mapping.location === 'path' && mapping.openapiName === parameterName) {
      return argumentName
    }
  }
  return parameterName
}
