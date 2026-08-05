/**
 * Route mapping: which MCP component type each HTTP route becomes.
 *
 * Port of Python FastMCP's `fastmcp.server.providers.openapi.routing`. User
 * maps are checked in order before the default map (everything becomes a
 * tool); the first map whose methods, pattern, and tags all match wins.
 */

import type { HTTPRoute, RouteMap } from './types'

/** Default route mapping: every route becomes a tool. */
export const DEFAULT_ROUTE_MAPPINGS: readonly RouteMap[] = [{ mcpType: 'tool' }]

function patternMatches(pattern: RegExp | string | undefined, path: string): boolean {
  if (pattern === undefined) return true
  if (typeof pattern === 'string') return new RegExp(pattern).test(path)
  // Unanchored search independent of the RegExp's lastIndex state.
  return path.search(pattern) !== -1
}

/** Find the first route map matching the route. Falls back to tool. */
export function determineRouteType(route: HTTPRoute, mappings: readonly RouteMap[]): RouteMap {
  for (const routeMap of mappings) {
    const methods = routeMap.methods ?? '*'
    if (methods !== '*' && !methods.includes(route.method)) continue

    if (!patternMatches(routeMap.pattern, route.path)) continue

    if (routeMap.tags && routeMap.tags.length > 0) {
      const routeTags = new Set(route.tags ?? [])
      if (!routeMap.tags.every((tag) => routeTags.has(tag))) continue
    }

    return routeMap
  }

  return { mcpType: 'tool' }
}
