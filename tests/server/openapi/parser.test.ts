import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadSpec, parseOpenAPIToHttpRoutes } from '../../../src/server/openapi/parser'
import type { HTTPRoute } from '../../../src/server/openapi/types'

const FIXTURES = fileURLToPath(new URL('../../fixtures/openapi', import.meta.url))

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

const petstoreSnapshot = readJson('petstore-3.1.default.snapshot.json') as {
  tools: Array<{ name: string; inputSchema: Record<string, unknown>; outputSchema: unknown }>
}

function findRoute(routes: HTTPRoute[], method: string, path: string): HTTPRoute {
  const route = routes.find((r) => r.method === method && r.path === path)
  if (!route) throw new Error(`route ${method} ${path} not found`)
  return route
}

function snapshotTool(name: string) {
  const tool = petstoreSnapshot.tools.find((t) => t.name === name)
  if (!tool) throw new Error(`snapshot tool ${name} not found`)
  return tool
}

describe('loadSpec', () => {
  it('passes objects through', () => {
    const spec = { openapi: '3.1.0' }
    expect(loadSpec(spec)).toBe(spec)
  })

  it('parses JSON text', () => {
    expect(loadSpec('{"openapi": "3.1.0"}')).toEqual({ openapi: '3.1.0' })
  })

  it('parses YAML text', () => {
    expect(loadSpec('openapi: 3.1.0\ninfo:\n  title: T\n')).toEqual({
      openapi: '3.1.0',
      info: { title: 'T' },
    })
  })

  it('rejects text that is not an object', () => {
    expect(() => loadSpec('- just\n- a list\n')).toThrow('must parse to an object')
  })
})

describe('parseOpenAPIToHttpRoutes', () => {
  const petstore = readJson('petstore-3.1.json')
  const routes = parseOpenAPIToHttpRoutes(petstore)

  it('extracts every operation in path order, methods in fixed order per path', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /pets',
      'POST /pets',
      'GET /pets/{petId}',
      'PUT /pets/{petId}',
      'DELETE /pets/{petId}',
      'GET /pets/{petId}/photos',
      'GET /owners/{ownerId}/pets/{petId}',
      'GET /search',
      'GET /reports',
      'POST /orders',
      'POST /shapes',
      'POST /notes',
      'POST /upload',
      'POST /audits',
      'GET /dup-a',
      'GET /dup-b',
      'GET /headers-test',
      'GET /filter',
      'GET /content-param',
    ])
  })

  it('merges path-level parameters into each operation', () => {
    const route = findRoute(routes, 'GET', '/pets/{petId}')
    expect(route.parameters).toHaveLength(1)
    expect(route.parameters[0]).toMatchObject({
      name: 'petId',
      location: 'path',
      required: true,
      description: 'Pet identifier.',
    })
  })

  it('keeps operation metadata: ids, summaries, tags, versions', () => {
    const route = findRoute(routes, 'GET', '/pets')
    expect(route.operationId).toBe('listPets')
    expect(route.summary).toBe('List all pets')
    expect(route.description).toBe('Returns every pet in the store.')
    expect(route.tags).toEqual(['pets', 'read'])
    expect(route.openapiVersion).toBe('3.1.0')
  })

  it('keeps only the primary success response', () => {
    const deletePet = findRoute(routes, 'DELETE', '/pets/{petId}')
    expect(Object.keys(deletePet.responses)).toEqual(['204'])
    expect(deletePet.responses['204'].contentSchema).toEqual({})

    const search = findRoute(routes, 'GET', '/search')
    expect(Object.keys(search.responses)).toEqual(['2XX'])
  })

  it('marks top-level component refs on response schemas', () => {
    const route = findRoute(routes, 'GET', '/pets/{petId}')
    const content = route.responses['200'].contentSchema['application/json']
    expect(content['x-fastmcp-top-level-schema']).toBe('Pet')
  })

  it('collects request schema dependencies including discriminator subtypes', () => {
    const shapes = findRoute(routes, 'POST', '/shapes')
    expect(Object.keys(shapes.requestSchemas).sort()).toEqual(['Circle', 'Shape', 'Square'])

    const createPet = findRoute(routes, 'POST', '/pets')
    expect(Object.keys(createPet.requestSchemas).sort()).toEqual(['Category', 'PetStatus'])
  })

  it('collects response schema dependencies including the top-level schema', () => {
    const route = findRoute(routes, 'GET', '/pets/{petId}')
    expect(Object.keys(route.responseSchemas).sort()).toEqual(['Category', 'Pet', 'PetStatus'])
  })

  it('never includes unreferenced component schemas', () => {
    for (const route of routes) {
      expect(Object.keys(route.requestSchemas)).not.toContain('Unused')
      expect(Object.keys(route.responseSchemas)).not.toContain('Unused')
    }
  })

  it('pre-calculates flat schemas that match the Python parity snapshot', () => {
    expect(findRoute(routes, 'PUT', '/pets/{petId}').flatParamSchema).toEqual(
      snapshotTool('replacePet').inputSchema,
    )
    expect(findRoute(routes, 'POST', '/shapes').flatParamSchema).toEqual(
      snapshotTool('createShape').inputSchema,
    )
    expect(findRoute(routes, 'POST', '/orders').flatParamSchema).toEqual(
      snapshotTool('createOrder').inputSchema,
    )
    expect(findRoute(routes, 'GET', '/reports').flatParamSchema).toEqual(
      snapshotTool('getReport').inputSchema,
    )
    expect(findRoute(routes, 'POST', '/notes').flatParamSchema).toEqual(
      snapshotTool('createNote').inputSchema,
    )
  })

  it('extracts explode and style on parameters', () => {
    const filter = findRoute(routes, 'GET', '/filter')
    const byName = Object.fromEntries(filter.parameters.map((p) => [p.name, p]))
    expect(byName.filter).toMatchObject({ style: 'deepObject', explode: true })
    expect(byName.ids).toMatchObject({ style: 'spaceDelimited', explode: false })
    expect(byName.codes).toMatchObject({ style: 'pipeDelimited', explode: false })
  })

  it('extracts content-based parameters from the first media type', () => {
    const route = findRoute(routes, 'GET', '/content-param')
    expect(route.parameters[0].schema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
    })
  })

  it('parses the 3.0 fixture with its version recorded', () => {
    const edge = readJson('edge-cases-3.0.json')
    const edgeRoutes = parseOpenAPIToHttpRoutes(edge)
    expect(edgeRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /widgets',
      'POST /widgets',
    ])
    expect(edgeRoutes[0].openapiVersion).toBe('3.0.3')
  })

  it('returns an empty list when the spec has no paths', () => {
    expect(parseOpenAPIToHttpRoutes({ openapi: '3.1.0' })).toEqual([])
  })

  it('throws on an external ref in a request body', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'X', version: '1' },
      paths: {
        '/a': {
          post: {
            requestBody: {
              content: {
                'application/json': { schema: { $ref: 'https://example.com/schema.json' } },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }
    expect(() => parseOpenAPIToHttpRoutes(spec)).toThrow(
      'External or non-local reference not supported',
    )
  })

  it('skips a parameter with an external ref instead of failing the spec', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'X', version: '1' },
      paths: {
        '/a': {
          get: {
            parameters: [
              { name: 'bad', in: 'query', schema: { $ref: 'https://example.com/x.json' } },
              { name: 'good', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }
    const parsed = parseOpenAPIToHttpRoutes(spec)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].parameters.map((p) => p.name)).toEqual(['good'])
  })

  it('resolves parameter refs through #/components/parameters', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'X', version: '1' },
      paths: {
        '/a': {
          get: {
            parameters: [{ $ref: '#/components/parameters/Limit' }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: {
        parameters: {
          Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } },
        },
      },
    }
    const parsed = parseOpenAPIToHttpRoutes(spec)
    expect(parsed[0].parameters[0]).toMatchObject({ name: 'limit', location: 'query' })
  })

  it('skips an operation whose request body ref is missing, keeping the rest', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'X', version: '1' },
      paths: {
        '/broken': {
          post: {
            requestBody: { $ref: '#/components/requestBodies/Missing' },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/ok': {
          get: { responses: { '200': { description: 'ok' } } },
        },
      },
    }
    // A missing local ref resolves to undefined -> the body extraction warns
    // and drops the body; the operation itself still parses (Python parity:
    // only external refs are fatal).
    const parsed = parseOpenAPIToHttpRoutes(spec)
    expect(parsed.map((r) => r.path)).toEqual(['/broken', '/ok'])
    expect(parsed[0].requestBody).toBeUndefined()
  })

  it('collects x- extension fields from the operation', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'X', version: '1' },
      paths: {
        '/a': {
          get: {
            'x-custom': { nested: true },
            'x-other': 7,
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }
    const parsed = parseOpenAPIToHttpRoutes(spec)
    expect(parsed[0].extensions).toEqual({ 'x-custom': { nested: true }, 'x-other': 7 })
  })
})
