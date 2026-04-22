import type { StandardSchemaV1 } from '@standard-schema/spec'
import { FastMCP } from '../../FastMCP'
import { toJsonSchema } from '../../tool'
import { actionRef } from '../actionRef'
import { Column, Input, Select, Button } from '../components'

export interface FormInputOptions {
  name: string
  description: string
  schema: StandardSchemaV1
}

type FieldSchema = Record<string, unknown>

function buildField(fieldName: string, fieldSchema: FieldSchema, required: string[]) {
  const isRequired = required.includes(fieldName)
  const type = fieldSchema.type as string | undefined
  if (Array.isArray(fieldSchema.enum)) {
    return Select({ name: fieldName, label: fieldName, options: fieldSchema.enum as string[], required: isRequired })
  }
  if (type === 'number' || type === 'integer') {
    return Input({ name: fieldName, label: fieldName, type: 'number', required: isRequired })
  }
  return Input({ name: fieldName, label: fieldName, type: 'text', required: isRequired })
}

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

    this.server.tool(
      { name, description, ui: { visibility: ['model', 'app'] } },
      async () => {
        // Use the shared extractor so Zod, Valibot, ArkType, etc. all work.
        const jsonSchema = await toJsonSchema(schema, `form "${name}"`)
        const properties = (jsonSchema.properties ?? {}) as Record<string, FieldSchema>
        const required = (jsonSchema.required ?? []) as string[]

        const fields = Object.entries(properties).map(([fieldName, fieldSchema]) =>
          buildField(fieldName, fieldSchema, required),
        )

        return Column({}, [...fields, Button({ label: 'Submit', action: actionRef(submitName) })])
      },
    )

    this.server.tool(
      {
        name: submitName,
        description: `Submit ${name} form data`,
        inputSchema: {
          type: 'object',
          properties: {
            data: { type: 'object', description: 'Form field values keyed by field name' },
          },
          required: ['data'],
        },
        ui: { visibility: ['app'] },
      },
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
