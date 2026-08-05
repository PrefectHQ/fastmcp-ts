/**
 * Component naming for generated MCP components.
 *
 * Port of Python FastMCP's `_slugify`, `_generate_default_name`, and
 * `_get_unique_name`. The order of operations is part of the parity contract:
 * names truncate to 56 characters BEFORE per-type numeric deduplication, so a
 * long name that collides becomes `<56 chars>_2`, not a re-truncated hybrid.
 */

import type { HTTPRoute } from './types'

/** Slug containing only letters, numbers, and underscores (case preserved). */
export function slugify(text: string): string {
  if (!text) return ''
  return text
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Default component name for a route: operationId (before any `__` suffix),
 * overridden by the `names` map, else summary, else `{METHOD}_{path}`.
 */
export function generateDefaultName(route: HTTPRoute, names?: Record<string, string>): string {
  let name: string
  if (route.operationId) {
    name = names?.[route.operationId] ?? route.operationId.split('__')[0]
  } else {
    name = route.summary || `${route.method}_${route.path}`
  }

  name = slugify(name)
  if (name.length > 56) name = name.slice(0, 56)
  return name
}

export type ComponentNameType = 'tool' | 'resource' | 'resourceTemplate' | 'prompt'

/** Per-type name counter that appends `_2`, `_3`, ... on collisions. */
export class NameRegistry {
  private readonly counters: Record<ComponentNameType, Map<string, number>> = {
    tool: new Map(),
    resource: new Map(),
    resourceTemplate: new Map(),
    prompt: new Map(),
  }

  getUniqueName(name: string, componentType: ComponentNameType): string {
    const counter = this.counters[componentType]
    const count = (counter.get(name) ?? 0) + 1
    counter.set(name, count)
    if (count === 1) return name
    return `${name}_${count}`
  }
}
