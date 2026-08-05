/** Small shared helpers for the OpenAPI port. Not exported from the package. */

/**
 * Python-style truthiness: the ported logic from Python FastMCP branches on
 * `if value:` where empty dicts, arrays, and strings are falsy. Faithful
 * branching needs the same notion here.
 */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural equality; object key order ignored, array order significant. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
    )
  }
  return false
}

export function warn(message: string): void {
  console.warn(`[fastmcp] ${message}`)
}
