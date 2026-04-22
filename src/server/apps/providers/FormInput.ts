import type { StandardSchemaV1 } from '@standard-schema/spec'
import { FastMCP } from '../../FastMCP'
import { Column, Input, Select, Button } from '../components'

export interface FormInputOptions {
  name: string
  description: string
  schema: StandardSchemaV1
}

type JsonSchema = Record<string, unknown>

/** Extract a JSON Schema from a Standard Schema validator (best-effort). */
async function extractJsonSchema(schema: StandardSchemaV1): Promise<JsonSchema> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any
  if (typeof s._def === 'object') {
    // Zod: use zod-to-json-schema or manual extraction
    return extractZodSchema(s)
  }
  if (typeof s.toJSONSchema === 'function') {
    return s.toJSONSchema() as JsonSchema
  }
  return { type: 'object', properties: {} }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractZodSchema(zodSchema: any): JsonSchema {
  // Supports Zod v3 (typeName === 'ZodObject', shape is a fn) and Zod v4 (type === 'object', shape is an object)
  const def = zodSchema._def ?? {}
  const isObject = def.typeName === 'ZodObject' || def.type === 'object'
  if (isObject) {
    const rawShape = typeof def.shape === 'function' ? def.shape() : (def.shape ?? {})
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [key, val] of Object.entries(rawShape as Record<string, unknown>)) {
      properties[key] = extractZodFieldSchema(val)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(val as any).isOptional?.()) required.push(key)
    }
    return { type: 'object', properties, required }
  }
  return { type: 'object', properties: {} }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractZodFieldSchema(field: any): JsonSchema {
  const def = field?._def ?? {}
  // Zod v3 uses typeName; Zod v4 uses type
  const typeName = (def.typeName ?? def.type) as string | undefined
  if (typeName === 'ZodString' || typeName === 'string') return { type: 'string' }
  if (typeName === 'ZodNumber' || typeName === 'number') return { type: 'number' }
  if (typeName === 'ZodBoolean' || typeName === 'boolean') return { type: 'boolean' }
  if (typeName === 'ZodOptional' || typeName === 'optional') {
    return extractZodFieldSchema(def.innerType)
  }
  if (typeName === 'ZodEnum' || typeName === 'enum') {
    return { type: 'string', enum: def.values ?? def.entries }
  }
  return {}
}

/** Validate data against a Standard Schema, returning field errors on failure. */
async function validateWithSchema(
  schema: StandardSchemaV1,
  data: unknown,
): Promise<{ valid: true; value: unknown } | { valid: false; errors: Record<string, string> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (schema['~standard'].validate as (v: unknown) => Promise<any>)(data)
  if (result.issues && result.issues.length > 0) {
    const errors: Record<string, string> = {}
    for (const issue of result.issues) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const path = issue.path?.map((p: any) => String(typeof p === 'object' ? p.key : p)).join('.') ?? 'root'
      errors[path] = String(issue.message)
    }
    return { valid: false, errors }
  }
  return { valid: true, value: result.value }
}

export class FormInput {
  readonly server: FastMCP

  constructor(options: FormInputOptions) {
    this.server = new FastMCP({ name: options.name })
    const { name, description, schema } = options
    const submitName = `${name}_submit`

    // LLM-visible: generates form UI from schema
    this.server.tool(
      { name, description, ui: { visibility: ['model', 'app'] } },
      async () => {
        const jsonSchema = await extractJsonSchema(schema)
        const properties = (jsonSchema.properties ?? {}) as Record<string, JsonSchema>
        const required = (jsonSchema.required ?? []) as string[]

        const fields = Object.entries(properties).map(([fieldName, fieldSchema]) => {
          const isRequired = required.includes(fieldName)
          const type = fieldSchema.type as string | undefined
          if (type === 'number' || type === 'integer') {
            return Input({ name: fieldName, label: fieldName, type: 'number', required: isRequired })
          }
          if (Array.isArray(fieldSchema.enum)) {
            return Select({ name: fieldName, label: fieldName, options: fieldSchema.enum as string[], required: isRequired })
          }
          return Input({ name: fieldName, label: fieldName, type: 'text', required: isRequired })
        })

        return Column({}, [...fields, Button({ label: 'Submit', action: submitName })])
      },
    )

    // Backend-only: called by the host bridge with form data
    this.server.tool(
      { name: submitName, description: `Submit ${name} form`, ui: { visibility: ['app'] } },
      async (args: Record<string, unknown>) => {
        const result = await validateWithSchema(schema, args.data)
        if (!result.valid) {
          return { errors: result.errors }
        }
        return result.value
      },
    )
  }
}
