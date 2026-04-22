import { theme } from './theme.js'

interface JsonSchemaProperty {
  type?: string
  description?: string
  enum?: unknown[]
  [key: string]: unknown
}

interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  [key: string]: unknown
}

export function renderSchema(schema: JsonSchema, json: boolean): string {
  if (json) {
    return JSON.stringify(schema, null, 2)
  }

  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const lines: string[] = []

  for (const [name, prop] of Object.entries(properties)) {
    const type = prop.type ?? 'any'
    const req = required.has(name) ? theme.warning('required') : theme.muted('optional')
    const desc = prop.enum
      ? prop.enum.map((v) => JSON.stringify(v)).join(' | ')
      : (prop.description ?? '')
    lines.push(
      `  ${theme.label(name.padEnd(16))} ${theme.code(String(type).padEnd(8))} ${req.padEnd(8 + 8)}  ${theme.muted(desc)}`,
    )
  }

  return lines.length ? lines.join('\n') : theme.muted('  (no parameters)')
}
