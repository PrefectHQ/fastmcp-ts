/**
 * createOpenAPIServer: build a FastMCP server from an OpenAPI 3.x spec.
 *
 * TypeScript port of Python FastMCP's `FastMCP.from_openapi` /
 * `OpenAPIProvider`. Components are generated eagerly: parse the spec into
 * routes, map each route to a component type, name it, derive its schemas,
 * and register it on a plain FastMCP with a forwarding handler that calls the
 * described HTTP API. Generated names and schemas match the Python
 * implementation byte for byte; the snapshots under `tests/fixtures/openapi/`
 * pin that contract.
 */

import { FastMCP } from '../FastMCP'
import type { FastMCPOptions } from '../FastMCP'
import type {
  ComponentFn,
  HTTPRoute,
  JsonSchema,
  OpenAPIComponent,
  OpenAPIResourceComponent,
  OpenAPIResourceTemplateComponent,
  OpenAPIToolComponent,
  RouteMap,
  RouteMapFn,
} from './types'
import { isPlainObject, truthy, warn } from './internal'
import { loadSpec, parseOpenAPIToHttpRoutes } from './parser'
import { extractOutputSchemaFromResponses } from './schemas'
import { DEFAULT_ROUTE_MAPPINGS, determineRouteType } from './routing'
import { NameRegistry, generateDefaultName } from './naming'
import { pathArgumentName } from './director'
import {
  readResourceRequest,
  resolveClient,
  runToolRequest,
} from './execute'
import type { OpenAPIClientOptions, ResolvedClient } from './execute'

export interface OpenAPIServerOptions {
  /** The OpenAPI 3.0/3.1 spec: a parsed object, or YAML/JSON text. */
  spec: Record<string, unknown> | string
  /** Server name. Default 'OpenAPI Server'. */
  name?: string
  /** Server version. Defaults to FastMCP's own default. */
  version?: string
  /** HTTP client configuration (base URL, headers, auth, fetch, timeout). */
  client?: OpenAPIClientOptions
  /** Route maps checked in order before the default (everything → tool). */
  routeMaps?: RouteMap[]
  /** Route-type hook, run after the route maps on every route. */
  routeMapFn?: RouteMapFn
  /** Component customization hook, called before each registration. */
  componentFn?: ComponentFn
  /** Overrides mapping operationId → component name. */
  names?: Record<string, string>
  /** Tags added to every generated component. */
  tags?: string[]
  /**
   * When true (default), tools advertise the output schema extracted from
   * the spec. When false, a permissive schema is advertised instead (the
   * wrap-result marker is preserved).
   */
  validateOutput?: boolean
  /** Remaining FastMCP options (auth, middleware, page sizes, ...). */
  serverOptions?: Omit<FastMCPOptions, 'name' | 'version'>
}

const DEFAULT_MIME_TYPE = 'application/json'

const JSON_COMPATIBLE_TYPES = [
  'application/json',
  'application/vnd.api+json',
  'application/hal+json',
  'application/ld+json',
  'text/json',
] as const

/** Primary MIME type from a route's success response; application/json fallback. */
function extractMimeTypeFromRoute(route: HTTPRoute): string {
  if (!truthy(route.responses)) return DEFAULT_MIME_TYPE

  let responseInfo = undefined
  for (const statusCode of ['200', '201', '202', '204']) {
    if (statusCode in route.responses) {
      responseInfo = route.responses[statusCode]
      break
    }
  }
  if (responseInfo === undefined) {
    for (const [statusCode, respInfo] of Object.entries(route.responses)) {
      if (statusCode.startsWith('2')) {
        responseInfo = respInfo
        break
      }
    }
  }
  if (responseInfo === undefined || !truthy(responseInfo.contentSchema)) return DEFAULT_MIME_TYPE

  const contentTypes = Object.keys(responseInfo.contentSchema)
  if (contentTypes.length === 1) return contentTypes[0]

  for (const contentType of JSON_COMPATIBLE_TYPES) {
    if (contentType in responseInfo.contentSchema) return contentType
  }
  return contentTypes[0]
}

/** Expand a `resource://name/{a}/{b}` template with matched parameter values. */
function expandTemplateUri(uriTemplate: string, params: Record<string, string>): string {
  let uri = uriTemplate
  for (const [name, value] of Object.entries(params)) {
    uri = uri.split(`{${name}}`).join(encodeURIComponent(value))
  }
  return uri
}

/** Map matched template params back to flat tool-argument names. */
function templateArguments(
  route: HTTPRoute,
  params: Record<string, string>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const parameter of route.parameters) {
    if (parameter.location !== 'path') continue
    const argumentName = pathArgumentName(route, parameter.name)
    if (parameter.name in params) {
      args[argumentName] = params[parameter.name]
      continue
    }
    const normalizedName = parameter.name.replace(/-/g, '_')
    if (normalizedName in params) {
      args[argumentName] = params[normalizedName]
    }
  }
  return args
}

/**
 * Create a FastMCP server from an OpenAPI 3.0/3.1 specification. Every
 * operation becomes an MCP component (tool by default; see `routeMaps`)
 * whose handler calls the described HTTP endpoint.
 */
export function createOpenAPIServer(options: OpenAPIServerOptions): FastMCP {
  const spec = loadSpec(options.spec)
  const client = resolveClient(options.client ?? {}, spec)
  const routes = parseOpenAPIToHttpRoutes(spec)

  const server = new FastMCP({
    name: options.name ?? 'OpenAPI Server',
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...options.serverOptions,
  })

  const routeMaps = [...(options.routeMaps ?? []), ...DEFAULT_ROUTE_MAPPINGS]
  const registry = new NameRegistry()
  const validateOutput = options.validateOutput ?? true

  for (const route of routes) {
    const routeMap = determineRouteType(route, routeMaps)
    let routeType = routeMap.mcpType

    if (options.routeMapFn !== undefined) {
      try {
        const result = options.routeMapFn(route, routeType)
        if (result !== null && result !== undefined) {
          routeType = result
        }
      } catch (error) {
        warn(
          `Error in routeMapFn for ${route.method} ${route.path}: ${(error as Error).message}. Using mapped type.`,
        )
      }
    }

    const componentName = generateDefaultName(route, options.names)
    const componentTags = [
      ...new Set([...route.tags, ...(routeMap.mcpTags ?? []), ...(options.tags ?? [])]),
    ].sort()

    if (routeType === 'tool') {
      createTool(server, client, route, componentName, componentTags, registry, validateOutput, options.componentFn)
    } else if (routeType === 'resource') {
      createResource(server, client, route, componentName, componentTags, registry, options.componentFn)
    } else if (routeType === 'resourceTemplate') {
      createTemplate(server, client, route, componentName, componentTags, registry, options.componentFn)
    }
    // 'exclude' routes are skipped.
  }

  return server
}

function applyComponentFn(
  componentFn: ComponentFn | undefined,
  route: HTTPRoute,
  component: OpenAPIComponent,
): void {
  if (componentFn === undefined) return
  try {
    componentFn(route, component)
  } catch (error) {
    warn(
      `Error in componentFn for ${component.kind} '${component.name}': ${(error as Error).message}`,
    )
  }
}

function createTool(
  server: FastMCP,
  client: ResolvedClient,
  route: HTTPRoute,
  name: string,
  tags: string[],
  registry: NameRegistry,
  validateOutput: boolean,
  componentFn: ComponentFn | undefined,
): void {
  let outputSchema = extractOutputSchemaFromResponses(
    route.responses,
    route.responseSchemas,
    route.openapiVersion,
  )

  if (!validateOutput && outputSchema !== null) {
    // Permissive schema: accept any object, but keep the wrap-result flag so
    // non-object responses still get wrapped.
    const permissive: JsonSchema = { type: 'object', additionalProperties: true }
    if (truthy(outputSchema['x-fastmcp-wrap-result'])) {
      permissive['x-fastmcp-wrap-result'] = true
    }
    outputSchema = permissive
  }

  const component: OpenAPIToolComponent = {
    kind: 'tool',
    name: registry.getUniqueName(name, 'tool'),
    description: route.description || route.summary || `Executes ${route.method} ${route.path}`,
    inputSchema: route.flatParamSchema,
    ...(outputSchema !== null ? { outputSchema } : {}),
    tags,
  }
  applyComponentFn(componentFn, route, component)

  server.tool(
    {
      name: component.name,
      description: component.description,
      inputSchema: component.inputSchema,
      ...(component.outputSchema !== undefined ? { outputSchema: component.outputSchema } : {}),
      tags: component.tags,
    },
    async (args: unknown) =>
      runToolRequest(client, route, isPlainObject(args) ? args : {}, component.outputSchema),
  )
}

function createResource(
  server: FastMCP,
  client: ResolvedClient,
  route: HTTPRoute,
  name: string,
  tags: string[],
  registry: NameRegistry,
  componentFn: ComponentFn | undefined,
): void {
  const uniqueName = registry.getUniqueName(name, 'resource')
  const component: OpenAPIResourceComponent = {
    kind: 'resource',
    uri: `resource://${uniqueName}`,
    name: uniqueName,
    description: route.description || route.summary || `Represents ${route.path}`,
    mimeType: extractMimeTypeFromRoute(route),
    tags,
  }
  applyComponentFn(componentFn, route, component)

  server.resource(
    {
      uri: component.uri,
      name: component.name,
      description: component.description,
      mimeType: component.mimeType,
      tags: component.tags,
    },
    async () => readResourceRequest(client, route, {}, component.uri, component.mimeType),
  )
}

function createTemplate(
  server: FastMCP,
  client: ResolvedClient,
  route: HTTPRoute,
  name: string,
  tags: string[],
  registry: NameRegistry,
  componentFn: ComponentFn | undefined,
): void {
  const uniqueName = registry.getUniqueName(name, 'resourceTemplate')

  // Template path parameters appear in the URI sorted alphabetically.
  const pathParams = route.parameters
    .filter((p) => p.location === 'path')
    .map((p) => p.name)
    .sort()
  let uriTemplate = `resource://${uniqueName}`
  if (pathParams.length > 0) {
    uriTemplate += '/' + pathParams.map((p) => `{${p}}`).join('/')
  }

  const parametersSchema: JsonSchema = {
    type: 'object',
    properties: Object.fromEntries(
      route.parameters
        .filter((p) => p.location === 'path')
        .map((p) => [
          p.name,
          {
            ...(isPlainObject(p.schema) ? p.schema : {}),
            ...(truthy(p.description) && !(isPlainObject(p.schema) && 'description' in p.schema)
              ? { description: p.description }
              : {}),
          },
        ]),
    ),
    required: route.parameters
      .filter((p) => p.location === 'path' && p.required)
      .map((p) => p.name),
  }

  const component: OpenAPIResourceTemplateComponent = {
    kind: 'resourceTemplate',
    uriTemplate,
    name: uniqueName,
    description: route.description || route.summary || `Template for ${route.path}`,
    mimeType: extractMimeTypeFromRoute(route),
    parameters: parametersSchema,
    tags,
  }
  applyComponentFn(componentFn, route, component)

  server.resource(
    {
      uri: component.uriTemplate,
      name: component.name,
      description: component.description,
      mimeType: component.mimeType,
      tags: component.tags,
    },
    async (params?: Record<string, string>) => {
      const matched = params ?? {}
      const concreteUri = expandTemplateUri(component.uriTemplate, matched)
      return readResourceRequest(
        client,
        route,
        templateArguments(route, matched),
        concreteUri,
        component.mimeType,
      )
    },
  )
}

export type { OpenAPIClientOptions } from './execute'
export type {
  ComponentFn,
  HTTPRoute,
  HttpMethod,
  JsonSchema,
  MCPType,
  OpenAPIComponent,
  OpenAPIResourceComponent,
  OpenAPIResourceTemplateComponent,
  OpenAPIToolComponent,
  ParameterInfo,
  ParameterLocation,
  RequestBodyInfo,
  ResponseInfo,
  RouteMap,
  RouteMapFn,
} from './types'
