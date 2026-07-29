import type { ClientCapabilities } from '@modelcontextprotocol/client'

/**
 * Compose caller-advertised capabilities with capabilities backed by FastMCP
 * handlers. Objects merge recursively; arrays and scalar leaves use the
 * inferred value on a conflict because those values describe behavior this
 * client actually implements.
 */
export function mergeClientCapabilities(
  supplied: ClientCapabilities | undefined,
  inferred: ClientCapabilities,
): ClientCapabilities {
  return mergeRecords(supplied ?? {}, inferred) as ClientCapabilities
}

function mergeRecords(
  supplied: Record<string, unknown>,
  inferred: Record<string, unknown>,
): Record<string, unknown> {
  const keys = new Set([...Object.keys(supplied), ...Object.keys(inferred)])

  return Object.fromEntries(
    [...keys].map((key) => {
      const suppliedValue = supplied[key]
      const inferredValue = inferred[key]

      if (isRecord(suppliedValue) && isRecord(inferredValue)) {
        return [key, mergeRecords(suppliedValue, inferredValue)]
      }
      if (key in inferred) return [key, cloneValue(inferredValue)]
      return [key, cloneValue(suppliedValue)]
    }),
  )
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isRecord(value)) return mergeRecords(value, {})
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
