import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { isInputRequiredResult } from './mrtr'
import type { InputRequiredResult } from './mrtr'

export class Image {
  constructor(
    readonly buffer: Buffer | Uint8Array,
    readonly mimeType: string,
  ) {}
}

export class File {
  constructor(
    readonly buffer: Buffer | Uint8Array,
    readonly name: string,
    readonly mimeType: string,
  ) {}
}

export class ToolResult {
  constructor(readonly result: CallToolResult) {}
}

export function convertResult(value: unknown): CallToolResult | InputRequiredResult {
  // Multi-round-trip escape hatch (protocol revision 2026-07-28): a handler that
  // needs more input from the client returns inputRequired({ ... }) — passed through
  // untouched, exactly like the ToolResult escape hatch below. See inputRequired /
  // acceptedContent / inputResponse (re-exported from fastmcp-ts/server).
  if (isInputRequiredResult(value)) {
    return value
  }
  if (value instanceof ToolResult) {
    return value.result
  }
  if (value instanceof Image) {
    return {
      content: [
        {
          type: 'image',
          data: Buffer.from(value.buffer).toString('base64'),
          mimeType: value.mimeType,
        },
      ],
    }
  }
  if (value instanceof File) {
    return {
      content: [
        {
          type: 'resource',
          resource: {
            uri: `file://${value.name}`,
            mimeType: value.mimeType,
            blob: Buffer.from(value.buffer).toString('base64'),
          },
        },
      ],
    }
  }
  if (value === undefined || value === null) {
    return { content: [] }
  }
  if (Array.isArray(value)) {
    console.warn(
      '[fastmcp] Tool returned an array — structuredContent will not be set (MCP spec requires a plain object). Wrap in an object or use ToolResult to suppress this warning.',
    )
    return {
      content: [{ type: 'text', text: JSON.stringify(value) }],
    }
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return {
      content: [{ type: 'text', text: json }],
      structuredContent: value as Record<string, unknown>,
    }
  }
  // string, number, boolean
  return {
    content: [{ type: 'text', text: String(value) }],
  }
}

export async function toJsonSchema(
  schema: StandardSchemaV1,
  context?: string,
): Promise<Record<string, unknown>> {
  // Strategy 1: schema-native .toJsonSchema() method (ArkType and any library following this convention)
  const maybeNative = schema as { toJsonSchema?: () => unknown }
  if (typeof maybeNative.toJsonSchema === 'function') {
    try {
      const result = maybeNative.toJsonSchema()
      if (result !== null && typeof result === 'object') {
        return result as Record<string, unknown>
      }
    } catch {
      // fall through
    }
  }

  // Strategy 2: Zod v4 z.toJSONSchema()
  try {
    const { z } = await import('zod')
    return (z as unknown as { toJSONSchema: (s: unknown) => Record<string, unknown> }).toJSONSchema(
      schema,
    )
  } catch {
    // fall through
  }

  const where = context ? ` for ${context}` : ''
  console.warn(
    `[fastmcp] Could not auto-generate JSON schema${where}. Sending { type: 'object' } to clients. Provide an explicit 'inputSchema' in ToolConfig to suppress this warning.`,
  )
  return { type: 'object' }
}

export async function validateInput<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
  throwAsProtocolError = false,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema['~standard'].validate(input)
  if (result.issues) {
    const messages = result.issues.map((i) => i.message).join('; ')
    if (throwAsProtocolError) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Validation failed: ${messages}`)
    }
    throw new Error(`Validation failed: ${messages}`)
  }
  return result.value as StandardSchemaV1.InferOutput<S>
}
