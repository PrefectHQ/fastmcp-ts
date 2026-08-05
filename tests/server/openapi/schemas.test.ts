import { describe, expect, it } from 'vitest'
import {
  combineSchemasAndMapParams,
  extractOutputSchemaFromResponses,
  replaceRefWithDefs,
} from '../../../src/server/openapi/schemas'
import type { HTTPRoute, ParameterInfo } from '../../../src/server/openapi/types'

function makeRoute(partial: Partial<HTTPRoute>): HTTPRoute {
  return {
    path: '/x',
    method: 'GET',
    tags: [],
    parameters: [],
    responses: {},
    requestSchemas: {},
    responseSchemas: {},
    extensions: {},
    openapiVersion: '3.1.0',
    flatParamSchema: {},
    parameterMap: {},
    ...partial,
  }
}

function param(overrides: Partial<ParameterInfo> & Pick<ParameterInfo, 'name'>): ParameterInfo {
  return { location: 'query', required: false, schema: { type: 'string' }, ...overrides }
}

describe('replaceRefWithDefs', () => {
  it('rewrites component refs to $defs', () => {
    expect(replaceRefWithDefs({ $ref: '#/components/schemas/Pet' })).toEqual({
      $ref: '#/$defs/Pet',
    })
  })

  it('leaves other local refs untouched', () => {
    expect(replaceRefWithDefs({ $ref: '#/components/parameters/P' })).toEqual({
      $ref: '#/components/parameters/P',
    })
  })

  it('throws on external references', () => {
    expect(() => replaceRefWithDefs({ $ref: 'https://example.com/x.json#/Pet' })).toThrow(
      'External or non-local reference not supported',
    )
  })

  it('recurses into properties, items, compositions, and map keywords', () => {
    expect(
      replaceRefWithDefs({
        type: 'object',
        properties: {
          a: { $ref: '#/components/schemas/A' },
          b: { type: 'array', items: { $ref: '#/components/schemas/B' } },
        },
        anyOf: [{ $ref: '#/components/schemas/C' }],
        additionalProperties: { $ref: '#/components/schemas/D' },
        patternProperties: { '^x-': { $ref: '#/components/schemas/E' } },
        propertyNames: { $ref: '#/components/schemas/F' },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/A' },
        b: { type: 'array', items: { $ref: '#/$defs/B' } },
      },
      anyOf: [{ $ref: '#/$defs/C' }],
      additionalProperties: { $ref: '#/$defs/D' },
      patternProperties: { '^x-': { $ref: '#/$defs/E' } },
      propertyNames: { $ref: '#/$defs/F' },
    })
  })

  it('applies the fallback description only when the schema has none', () => {
    expect(replaceRefWithDefs({ type: 'string' }, 'from param')).toEqual({
      type: 'string',
      description: 'from param',
    })
    expect(replaceRefWithDefs({ type: 'string', description: 'own' }, 'from param')).toEqual({
      type: 'string',
      description: 'own',
    })
  })
})

describe('combineSchemasAndMapParams', () => {
  it('combines parameters into a flat object schema with a parameter map', () => {
    const route = makeRoute({
      parameters: [
        param({ name: 'id', location: 'path', required: true, schema: { type: 'integer' } }),
        param({ name: 'verbose', description: 'More output.' }),
      ],
    })
    const [schema, map] = combineSchemasAndMapParams(route)
    expect(schema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'integer' },
        verbose: { type: 'string', description: 'More output.' },
      },
      required: ['id'],
    })
    expect(map).toEqual({
      id: { location: 'path', openapiName: 'id' },
      verbose: { location: 'query', openapiName: 'verbose' },
    })
  })

  it('suffixes parameters that collide across locations', () => {
    const route = makeRoute({
      parameters: [
        param({ name: 'format', location: 'query' }),
        param({ name: 'format', location: 'header', description: 'Header format.' }),
      ],
    })
    const [schema, map] = combineSchemasAndMapParams(route)
    expect(schema.properties).toEqual({
      format__query: { type: 'string', description: '(Query parameter)' },
      format__header: {
        type: 'string',
        description: 'Header format. (Header parameter)',
      },
    })
    expect(map).toEqual({
      format__query: { location: 'query', openapiName: 'format' },
      format__header: { location: 'header', openapiName: 'format' },
    })
  })

  it('suffixes parameters that collide with body properties, body wins the bare name', () => {
    const route = makeRoute({
      parameters: [
        param({ name: 'petId', location: 'path', required: true, schema: { type: 'integer' } }),
      ],
      requestBody: {
        required: true,
        contentSchema: {
          'application/json': {
            type: 'object',
            properties: { petId: { type: 'integer' }, name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
    })
    const [schema, map] = combineSchemasAndMapParams(route)
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      'petId__path',
      'petId',
      'name',
    ])
    expect(schema.required).toEqual(['petId__path', 'name'])
    expect(map.petId).toEqual({ location: 'body', openapiName: 'petId' })
    expect(map.petId__path).toEqual({ location: 'path', openapiName: 'petId' })
  })

  it('merges allOf request bodies through $defs members', () => {
    const route = makeRoute({
      requestBody: {
        required: true,
        contentSchema: {
          'application/json': {
            allOf: [{ $ref: '#/$defs/Base' }, { $ref: '#/$defs/Extra' }],
          },
        },
      },
      requestSchemas: {
        Base: {
          type: 'object',
          properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
          required: ['sku'],
        },
        Extra: {
          type: 'object',
          properties: { note: { type: 'string' }, quantity: { type: 'integer' } },
          required: ['quantity'],
        },
      },
    })
    const [schema] = combineSchemasAndMapParams(route)
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      'sku',
      'quantity',
      'note',
    ])
    expect(schema.required).toEqual(['sku', 'quantity'])
  })

  it('keeps a pure-$ref body as a single body property', () => {
    const route = makeRoute({
      requestBody: {
        required: true,
        contentSchema: { 'application/json': { $ref: '#/$defs/Elsewhere' } },
      },
    })
    const [schema, map] = combineSchemasAndMapParams(route)
    expect(schema.properties).toEqual({ body: { $ref: '#/$defs/Elsewhere' } })
    expect(schema.required).toEqual(['body'])
    expect(map.body).toEqual({ location: 'body', openapiName: 'body' })
  })

  it('names a non-object body from its title', () => {
    const route = makeRoute({
      requestBody: {
        required: true,
        contentSchema: { 'application/json': { type: 'string', title: 'Note Text' } },
      },
    })
    const [schema, map] = combineSchemasAndMapParams(route)
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(['note_text'])
    expect(schema.required).toEqual(['note_text'])
    expect(map.note_text).toEqual({ location: 'body', openapiName: 'note_text' })
  })

  it('falls back to body_data when the title slug is unusable', () => {
    const route = makeRoute({
      requestBody: {
        required: false,
        contentSchema: { 'application/json': { type: 'array', title: '123 go' } },
      },
    })
    const [schema] = combineSchemasAndMapParams(route)
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(['body_data'])
    expect(schema.required).toEqual([])
  })

  it('flattens discriminator subtypes into optional fields with an anyOf for conflicts', () => {
    const route = makeRoute({
      requestBody: {
        required: true,
        contentSchema: {
          'application/json': {
            type: 'object',
            properties: { kind: { type: 'string' } },
            required: ['kind'],
            discriminator: {
              propertyName: 'kind',
              mapping: { circle: '#/components/schemas/Circle', square: 'Square' },
            },
          },
        },
      },
      requestSchemas: {
        Circle: {
          type: 'object',
          properties: { kind: { type: 'string' }, radius: { type: 'number' }, area: { type: 'number' } },
        },
        Square: {
          type: 'object',
          properties: { side: { type: 'number' }, area: { type: 'integer' } },
        },
      },
    })
    const [schema] = combineSchemasAndMapParams(route)
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.radius).toEqual({ type: 'number' })
    expect(properties.side).toEqual({ type: 'number' })
    expect(properties.area).toEqual({ anyOf: [{ type: 'number' }, { type: 'integer' }] })
    expect(properties.kind.description).toBe(
      "Selects the variant. Accepted values: 'circle', 'square'. " +
        "'circle' uses radius, area; 'square' uses side, area. " +
        'Send only the fields belonging to the selected variant.',
    )
    // The discriminator keyword itself is dropped.
    expect(schema.discriminator).toBeUndefined()
    expect(schema.required).toEqual(['kind'])
  })

  it('attaches requestSchemas as $defs and runs the 3.x conversion', () => {
    const route = makeRoute({
      openapiVersion: '3.0.3',
      parameters: [param({ name: 'kind', schema: { type: 'string', nullable: true } })],
      requestSchemas: { D: { oneOf: [{ type: 'string' }] } },
    })
    const [schema] = combineSchemasAndMapParams(route)
    expect(schema.properties).toEqual({ kind: { type: ['string', 'null'] } })
    expect(schema.$defs).toEqual({ D: { anyOf: [{ type: 'string' }] } })
  })

  it('does not require body properties when the body itself is optional', () => {
    const route = makeRoute({
      requestBody: {
        required: false,
        contentSchema: {
          'application/json': {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a'],
          },
        },
      },
    })
    const [schema] = combineSchemasAndMapParams(route)
    expect(schema.required).toEqual([])
  })
})

describe('extractOutputSchemaFromResponses', () => {
  it('returns null when there are no responses or no content', () => {
    expect(extractOutputSchemaFromResponses({})).toBeNull()
    expect(
      extractOutputSchemaFromResponses({ '204': { description: 'gone', contentSchema: {} } }),
    ).toBeNull()
    expect(
      extractOutputSchemaFromResponses({
        '200': { contentSchema: { 'application/json': {} } },
      }),
    ).toBeNull()
  })

  it('prefers explicit success codes in priority order', () => {
    const schema = extractOutputSchemaFromResponses({
      '201': {
        contentSchema: { 'application/json': { type: 'object', properties: { b: { type: 'string' } } } },
      },
      '200': {
        contentSchema: { 'application/json': { type: 'object', properties: { a: { type: 'string' } } } },
      },
    })
    expect(schema).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })

  it('falls back to any 2xx-style code', () => {
    const schema = extractOutputSchemaFromResponses({
      '2XX': {
        contentSchema: { 'application/json': { type: 'object', properties: { ok: { type: 'boolean' } } } },
      },
    })
    expect(schema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } })
  })

  it('prefers JSON-compatible content types, then falls back to the first', () => {
    expect(
      extractOutputSchemaFromResponses({
        '200': {
          contentSchema: {
            'text/plain': { type: 'string' },
            'application/hal+json': { type: 'object', properties: {} },
          },
        },
      }),
    ).toEqual({ type: 'object', properties: {} })

    expect(
      extractOutputSchemaFromResponses({
        '200': { contentSchema: { 'text/plain': { type: 'string' } } },
      }),
    ).toEqual({
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      'x-fastmcp-wrap-result': true,
    })
  })

  it('wraps non-object schemas and carries $defs on the wrapper', () => {
    const schema = extractOutputSchemaFromResponses(
      {
        '200': {
          contentSchema: {
            'application/json': { type: 'array', items: { $ref: '#/$defs/Pet' } },
          },
        },
      },
      { Pet: { type: 'object', properties: { name: { type: 'string', nullable: true } } } },
      '3.0.3',
    )
    expect(schema).toEqual({
      type: 'object',
      properties: { result: { type: 'array', items: { $ref: '#/$defs/Pet' } } },
      required: ['result'],
      'x-fastmcp-wrap-result': true,
      $defs: { Pet: { type: 'object', properties: { name: { type: ['string', 'null'] } } } },
    })
  })

  it('inlines a top-level $ref from the definitions', () => {
    const schema = extractOutputSchemaFromResponses(
      { '200': { contentSchema: { 'application/json': { $ref: '#/$defs/Pet' } } } },
      { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
      '3.1.0',
    )
    expect(schema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      $defs: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
    })
  })
})
