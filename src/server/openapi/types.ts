/**
 * Shared types for the OpenAPI integration.
 *
 * The intermediate representation (HTTPRoute and friends) is a direct port of
 * Python FastMCP's `fastmcp.utilities.openapi.models` so the two
 * implementations generate identical MCP components from the same spec. The
 * parity contract is pinned by the snapshots in `tests/fixtures/openapi/`.
 */

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'OPTIONS'
  | 'HEAD'
  | 'TRACE'

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie'

export type JsonSchema = Record<string, unknown>

/** A single parameter of an HTTP operation. */
export interface ParameterInfo {
  name: string
  location: ParameterLocation
  required: boolean
  schema: JsonSchema
  description?: string
  /** OpenAPI explode property for array/object serialization. */
  explode?: boolean
  /** OpenAPI style property (form, spaceDelimited, pipeDelimited, deepObject, ...). */
  style?: string
}

/** The request body of an HTTP operation, keyed by media type. */
export interface RequestBodyInfo {
  required: boolean
  contentSchema: Record<string, JsonSchema>
  description?: string
}

/** The primary success response of an HTTP operation, keyed by media type. */
export interface ResponseInfo {
  description?: string
  contentSchema: Record<string, JsonSchema>
}

/** Where a flattened tool argument goes when the HTTP request is built. */
export interface ParameterMapping {
  location: ParameterLocation | 'body'
  openapiName: string
}

/** Intermediate representation of a single OpenAPI operation. */
export interface HTTPRoute {
  path: string
  method: HttpMethod
  operationId?: string
  summary?: string
  description?: string
  tags: string[]
  parameters: ParameterInfo[]
  requestBody?: RequestBodyInfo
  /** Only the primary success response, keyed by its status code string. */
  responses: Record<string, ResponseInfo>
  /** Schema definitions needed by the input (parameters + request body). */
  requestSchemas: Record<string, JsonSchema>
  /** Schema definitions needed by the output (responses). */
  responseSchemas: Record<string, JsonSchema>
  /** `x-` extension fields found on the operation. */
  extensions: Record<string, unknown>
  openapiVersion?: string
  /** Pre-calculated flat input schema advertised on the MCP tool. */
  flatParamSchema: JsonSchema
  /** Maps flat argument names back to their OpenAPI locations. */
  parameterMap: Record<string, ParameterMapping>
}

/** Type of FastMCP component to create from a route. */
export type MCPType = 'tool' | 'resource' | 'resourceTemplate' | 'exclude'

/** Mapping rule from HTTP routes to FastMCP component types. */
export interface RouteMap {
  /** HTTP methods to match. `'*'` (default) matches every method. */
  methods?: HttpMethod[] | '*'
  /** Pattern searched (unanchored) against the route path. Default matches all. */
  pattern?: RegExp | string
  /** Tags that must ALL be present on the route for the map to match. */
  tags?: string[]
  /** The component type to create for matching routes. */
  mcpType: MCPType
  /** Extra tags applied to components created by this map. */
  mcpTags?: string[]
}

/**
 * Advanced route-type hook, run after the route maps on every non-excluded
 * route. Return a new MCPType to override, or null/undefined to keep the
 * mapped type. Exceptions are swallowed with a warning.
 */
export type RouteMapFn = (route: HTTPRoute, mcpType: MCPType) => MCPType | null | undefined

/** Mutable pre-registration view of a generated tool. */
export interface OpenAPIToolComponent {
  kind: 'tool'
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  tags: string[]
}

/** Mutable pre-registration view of a generated resource. */
export interface OpenAPIResourceComponent {
  kind: 'resource'
  uri: string
  name: string
  description: string
  mimeType: string
  tags: string[]
}

/** Mutable pre-registration view of a generated resource template. */
export interface OpenAPIResourceTemplateComponent {
  kind: 'resourceTemplate'
  uriTemplate: string
  name: string
  description: string
  mimeType: string
  parameters: JsonSchema
  tags: string[]
}

export type OpenAPIComponent =
  | OpenAPIToolComponent
  | OpenAPIResourceComponent
  | OpenAPIResourceTemplateComponent

/**
 * Component customization hook, called with each generated component before
 * registration. Mutate the component in place (rename, edit description,
 * adjust tags or schemas). Exceptions are swallowed with a warning.
 */
export type ComponentFn = (route: HTTPRoute, component: OpenAPIComponent) => void
