/**
 * Schema library compatibility tests.
 *
 * Verifies that FastMCP works correctly with the major Standard Schema-compliant
 * libraries for both runtime validation and JSON schema advertisement.
 *
 * Coverage:
 *   Zod v4      — JSON schema via z.toJSONSchema() (Strategy 2)
 *   ArkType     — JSON schema via schema-native .toJsonSchema() (Strategy 1)
 *   Valibot     — runtime validation works; JSON schema falls back (no built-in generator)
 *   Duck-typed  — any StandardSchemaV1 with a .toJsonSchema() method (Strategy 1 generic)
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { type } from 'arktype'
import * as v from 'valibot'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { FastMCP } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withTool(
  schema: StandardSchemaV1,
  handler: (args: any) => unknown,
) {
  const mcp = new FastMCP({ name: 'test' })
  mcp.tool({ name: 'x', input: schema }, handler)
  const { client, close } = await createTestClient(mcp)
  return { client, close }
}

// ---------------------------------------------------------------------------
// Zod v4
// ---------------------------------------------------------------------------

describe('Zod v4', () => {
  it('serialises inputSchema to clients via z.toJSONSchema()', async () => {
    const schema = z.object({ a: z.number(), b: z.string() })
    const { client, close } = await withTool(schema, () => 'ok')
    try {
      const { tools } = await client.listTools()
      const inputSchema = tools[0].inputSchema as Record<string, unknown>
      expect(inputSchema.type).toBe('object')
      expect((inputSchema.properties as Record<string, unknown>)).toMatchObject({
        a: { type: 'number' },
        b: { type: 'string' },
      })
      expect(inputSchema.required).toContain('a')
    } finally {
      await close()
    }
  })

  it('validates input and passes typed args to the handler', async () => {
    const schema = z.object({ n: z.coerce.number() })
    let received: unknown
    const { client, close } = await withTool(schema, ({ n }: { n: number }) => {
      received = n
      return n
    })
    try {
      const result = await client.callTool({ name: 'x', arguments: { n: '7' } })
      expect(result.isError).toBeFalsy()
      expect(received).toBe(7)
      expect(typeof received).toBe('number')
    } finally {
      await close()
    }
  })

  it('rejects invalid input before the handler runs', async () => {
    const schema = z.object({ age: z.number().min(0) })
    const spy = vi.fn()
    const { client, close } = await withTool(schema, spy)
    try {
      const result = await client.callTool({ name: 'x', arguments: { age: -1 } })
      expect(result.isError).toBe(true)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// ArkType — uses schema-native .toJsonSchema() (Strategy 1)
// ---------------------------------------------------------------------------

describe('ArkType', () => {
  it('serialises inputSchema to clients via the schema-native .toJsonSchema() method', async () => {
    const schema = type({ name: 'string', age: 'number' })
    const { client, close } = await withTool(schema, () => 'ok')
    try {
      const { tools } = await client.listTools()
      const inputSchema = tools[0].inputSchema as Record<string, unknown>
      expect(inputSchema.type).toBe('object')
      expect((inputSchema.properties as Record<string, unknown>)).toMatchObject({
        name: { type: 'string' },
        age: { type: 'number' },
      })
    } finally {
      await close()
    }
  })

  it('validates input and passes typed args to the handler', async () => {
    const schema = type({ x: 'number', y: 'number' })
    let received: unknown
    const { client, close } = await withTool(schema, (args) => {
      received = args
      return 'ok'
    })
    try {
      await client.callTool({ name: 'x', arguments: { x: 3, y: 4 } })
      expect(received).toEqual({ x: 3, y: 4 })
    } finally {
      await close()
    }
  })

  it('rejects invalid input before the handler runs', async () => {
    const schema = type({ value: 'number' })
    const spy = vi.fn()
    const { client, close } = await withTool(schema, spy)
    try {
      const result = await client.callTool({ name: 'x', arguments: { value: 'not-a-number' } })
      expect(result.isError).toBe(true)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// Valibot — validates correctly; JSON schema falls back with a warning
// ---------------------------------------------------------------------------

describe('Valibot', () => {
  it('validates input correctly even though JSON schema generation falls back', async () => {
    const schema = v.object({ name: v.string(), age: v.number() })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let received: unknown
      const { client, close } = await withTool(schema, (args) => {
        received = args
        return 'ok'
      })
      try {
        await client.callTool({ name: 'x', arguments: { name: 'Alice', age: 30 } })
        expect(received).toEqual({ name: 'Alice', age: 30 })
      } finally {
        await close()
      }
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('rejects invalid input before the handler runs', async () => {
    const schema = v.object({ age: v.number() })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const spy = vi.fn()
      const { client, close } = await withTool(schema, spy)
      try {
        const result = await client.callTool({ name: 'x', arguments: { age: 'oops' } })
        expect(result.isError).toBe(true)
        expect(spy).not.toHaveBeenCalled()
      } finally {
        await close()
      }
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('emits a warning and falls back to { type: object } when generating inputSchema', async () => {
    const schema = v.object({ x: v.number() })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client, close } = await withTool(schema, () => 'ok')
      try {
        const { tools } = await client.listTools()
        expect(tools[0].inputSchema.type).toBe('object')
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[fastmcp]'))
      } finally {
        await close()
      }
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('uses an explicit inputSchema override and emits no warning', async () => {
    const schema = v.object({ x: v.number() })
    const explicitSchema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'x', input: schema, inputSchema: explicitSchema }, () => 'ok')
      const { client, close } = await createTestClient(mcp)
      try {
        const { tools } = await client.listTools()
        const inputSchema = tools[0].inputSchema as Record<string, unknown>
        expect((inputSchema.properties as Record<string, unknown>)).toMatchObject({ x: { type: 'number' } })
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        await close()
      }
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Duck-typed: any Standard Schema with a .toJsonSchema() method (Strategy 1 generic)
// ---------------------------------------------------------------------------

describe('duck-typed .toJsonSchema() (Strategy 1 generic)', () => {
  it('uses the schema-native .toJsonSchema() method for any conforming library', async () => {
    // A hand-rolled Standard Schema validator that also exposes .toJsonSchema()
    const customSchema: StandardSchemaV1<{ count: number }> & {
      toJsonSchema: () => Record<string, unknown>
    } = {
      '~standard': {
        version: 1,
        vendor: 'custom',
        validate(input) {
          if (
            input !== null &&
            typeof input === 'object' &&
            'count' in input &&
            typeof (input as Record<string, unknown>).count === 'number'
          ) {
            return { value: input as { count: number } }
          }
          return { issues: [{ message: 'expected { count: number }' }] }
        },
      },
      toJsonSchema() {
        return {
          type: 'object',
          properties: { count: { type: 'integer', minimum: 0 } },
          required: ['count'],
        }
      },
    }

    const { client, close } = await withTool(customSchema, () => 'ok')
    try {
      const { tools } = await client.listTools()
      const inputSchema = tools[0].inputSchema as Record<string, unknown>
      expect(inputSchema.type).toBe('object')
      expect((inputSchema.properties as Record<string, unknown>)).toMatchObject({
        count: { type: 'integer', minimum: 0 },
      })
    } finally {
      await close()
    }
  })

  it('validates input using ~standard.validate even when .toJsonSchema() is present', async () => {
    const customSchema: StandardSchemaV1<{ label: string }> & {
      toJsonSchema: () => Record<string, unknown>
    } = {
      '~standard': {
        version: 1,
        vendor: 'custom',
        validate(input) {
          if (
            input !== null &&
            typeof input === 'object' &&
            typeof (input as Record<string, unknown>).label === 'string'
          ) {
            return { value: input as { label: string } }
          }
          return { issues: [{ message: 'label must be a string' }] }
        },
      },
      toJsonSchema: () => ({ type: 'object', properties: { label: { type: 'string' } } }),
    }

    const spy = vi.fn()
    const { client, close } = await withTool(customSchema, spy)
    try {
      // Valid call
      await client.callTool({ name: 'x', arguments: { label: 'hello' } })
      expect(spy).toHaveBeenCalledOnce()

      // Invalid call
      const result = await client.callTool({ name: 'x', arguments: { label: 123 } })
      expect(result.isError).toBe(true)
      expect(spy).toHaveBeenCalledOnce() // not called again
    } finally {
      await close()
    }
  })
})
