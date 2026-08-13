import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildRequest } from '../../../src/server/openapi/director'
import { parseOpenAPIToHttpRoutes } from '../../../src/server/openapi/parser'
import type { HTTPRoute, ParameterInfo } from '../../../src/server/openapi/types'

const petstore = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/openapi/petstore-3.1.json', import.meta.url)),
    'utf8',
  ),
)
const routes = parseOpenAPIToHttpRoutes(petstore)

function fixtureRoute(method: string, path: string): HTTPRoute {
  const route = routes.find((r) => r.method === method && r.path === path)
  if (!route) throw new Error(`route ${method} ${path} not found`)
  return route
}

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

function queryParam(
  overrides: Partial<ParameterInfo> & Pick<ParameterInfo, 'name'>,
): ParameterInfo {
  return { location: 'query', required: false, schema: {}, ...overrides }
}

const BASE = 'https://api.example.com/v1'

describe('buildRequest', () => {
  it('substitutes and strictly encodes path parameters', () => {
    const request = buildRequest(fixtureRoute('GET', '/pets/{petId}'), { petId: 42 }, BASE)
    expect(request).toEqual({
      method: 'GET',
      url: 'https://api.example.com/v1/pets/42',
      headers: {},
    })

    const encoded = buildRequest(
      fixtureRoute('GET', '/pets/{petId}'),
      { petId: '../a.b c/d' },
      BASE,
    )
    expect(encoded.url).toBe('https://api.example.com/v1/pets/%2E%2E%2Fa%2Eb%20c%2Fd')
  })

  it('routes suffixed arguments back to their locations', () => {
    const request = buildRequest(
      fixtureRoute('PUT', '/pets/{petId}'),
      { petId__path: 7, petId: 9, name: 'Rex' },
      BASE,
    )
    expect(request.method).toBe('PUT')
    expect(request.url).toBe('https://api.example.com/v1/pets/7')
    expect(request.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request.body as string)).toEqual({ petId: 9, name: 'Rex' })
  })

  it('drops null and undefined arguments', () => {
    const request = buildRequest(
      fixtureRoute('GET', '/pets'),
      { limit: null, status: undefined, tags: ['a'] },
      BASE,
    )
    expect(request.url).toBe('https://api.example.com/v1/pets?tags=a')
  })

  it('skips arguments that are not in the parameter map', () => {
    const request = buildRequest(fixtureRoute('GET', '/pets'), { unknown: 'x' }, BASE)
    expect(request.url).toBe('https://api.example.com/v1/pets')
  })

  it('serializes query styles: repeat, comma, space, pipe, deepObject', () => {
    const repeat = buildRequest(
      makeRoute({
        parameters: [queryParam({ name: 'ids' })],
        parameterMap: { ids: { location: 'query', openapiName: 'ids' } },
      }),
      { ids: [1, 2] },
      BASE,
    )
    expect(repeat.url).toBe('https://api.example.com/v1/x?ids=1&ids=2')

    const form = buildRequest(fixtureRoute('GET', '/pets'), { tags: ['a', 'b'] }, BASE)
    expect(form.url).toBe('https://api.example.com/v1/pets?tags=a%2Cb')

    const filter = buildRequest(
      fixtureRoute('GET', '/filter'),
      {
        ids: [1, 2],
        codes: ['x', 'y'],
        filter: { color: 'red', size: 5 },
      },
      BASE,
    )
    const url = new URL(filter.url)
    expect(url.searchParams.get('ids')).toBe('1 2')
    expect(url.searchParams.get('codes')).toBe('x|y')
    expect(url.searchParams.get('filter[color]')).toBe('red')
    expect(url.searchParams.get('filter[size]')).toBe('5')
  })

  it('fans exploded form-style objects out into bare property keys', () => {
    const request = buildRequest(
      makeRoute({
        parameters: [queryParam({ name: 'coords', explode: true })],
        parameterMap: { coords: { location: 'query', openapiName: 'coords' } },
      }),
      { coords: { lat: 1, lon: 2 } },
      BASE,
    )
    expect(request.url).toBe('https://api.example.com/v1/x?lat=1&lon=2')
  })

  it('joins non-exploded objects as key,value pairs', () => {
    const request = buildRequest(
      makeRoute({
        parameters: [queryParam({ name: 'color', explode: false })],
        parameterMap: { color: { location: 'query', openapiName: 'color' } },
      }),
      { color: { R: 100, G: 200 } },
      BASE,
    )
    expect(new URL(request.url).searchParams.get('color')).toBe('R,100,G,200')
  })

  it('lowercases booleans in query, header, and cookie values', () => {
    const request = buildRequest(
      makeRoute({
        parameters: [
          queryParam({ name: 'active' }),
          queryParam({ name: 'X-Flag', location: 'header' }),
          queryParam({ name: 'session', location: 'cookie' }),
        ],
        parameterMap: {
          active: { location: 'query', openapiName: 'active' },
          'X-Flag': { location: 'header', openapiName: 'X-Flag' },
          session: { location: 'cookie', openapiName: 'session' },
        },
      }),
      { active: true, 'X-Flag': false, session: true },
      BASE,
    )
    expect(request.url).toBe('https://api.example.com/v1/x?active=true')
    expect(request.headers['X-Flag']).toBe('false')
    expect(request.headers.cookie).toBe('session=true')
  })

  it('sends object bodies as JSON with the declared content type', () => {
    const request = buildRequest(
      fixtureRoute('POST', '/pets'),
      { id: 1, name: 'Rex', category: { id: 2, name: 'dogs' } },
      BASE,
    )
    expect(request.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request.body as string)).toEqual({
      id: 1,
      name: 'Rex',
      category: { id: 2, name: 'dogs' },
    })
  })

  it('sends a single non-object body property as the raw value', () => {
    const request = buildRequest(fixtureRoute('POST', '/notes'), { note_text: 'hello' }, BASE)
    // Body schema type is string (not object), one property -> the value goes
    // out raw, not JSON-encoded (Python parity).
    expect(request.body).toBe('hello')
  })

  it('keeps JSON-compatible non-json content types on the header', () => {
    const route = makeRoute({
      method: 'PATCH',
      requestBody: {
        required: true,
        contentSchema: {
          'application/json-patch+json': { type: 'array', items: { type: 'object' } },
        },
      },
      parameterMap: { ops: { location: 'body', openapiName: 'ops' } },
    })
    const request = buildRequest(route, { ops: [{ op: 'add' }] }, BASE)
    expect(request.headers['content-type']).toBe('application/json-patch+json')
    // Single body prop and non-object schema -> the array value directly.
    expect(JSON.parse(request.body as string)).toEqual([{ op: 'add' }])
  })

  it('builds multipart form data', () => {
    const request = buildRequest(
      fixtureRoute('POST', '/upload'),
      { file: new Uint8Array([1, 2, 3]), description: 'binary', flag: true },
      BASE,
    )
    expect(request.body).toBeInstanceOf(FormData)
    const form = request.body as FormData
    expect(form.get('description')).toBe('binary')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })

  it('builds urlencoded bodies', () => {
    const route = makeRoute({
      method: 'POST',
      requestBody: {
        required: true,
        contentSchema: {
          'application/x-www-form-urlencoded': {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'boolean' } },
          },
        },
      },
      parameterMap: {
        a: { location: 'body', openapiName: 'a' },
        b: { location: 'body', openapiName: 'b' },
      },
    })
    const request = buildRequest(route, { a: 'x', b: true }, BASE)
    expect(request.body).toBeInstanceOf(URLSearchParams)
    expect((request.body as URLSearchParams).toString()).toBe('a=x&b=true')
  })

  it('sends raw scalar bodies with the declared content type', () => {
    const route = makeRoute({
      method: 'POST',
      requestBody: {
        required: true,
        contentSchema: { 'text/plain': { type: 'string' } },
      },
      parameterMap: { text: { location: 'body', openapiName: 'text' } },
    })
    const request = buildRequest(route, { text: 'raw body' }, BASE)
    expect(request.body).toBe('raw body')
    expect(request.headers['content-type']).toBe('text/plain')
  })

  it('falls back to suffix and location mapping when the parameter map is empty', () => {
    const route = makeRoute({
      path: '/things/{id}',
      parameters: [queryParam({ name: 'q' })],
      parameterMap: {},
    })
    const request = buildRequest(route, { id__path: 5, q: 'find', extra: 'body' }, BASE)
    expect(request.url).toBe('https://api.example.com/v1/things/5?q=find')
    expect(JSON.parse(request.body as string)).toEqual({ extra: 'body' })
  })

  it('joins base URLs without duplicate slashes', () => {
    const route = fixtureRoute('GET', '/pets')
    expect(buildRequest(route, {}, 'https://api.example.com/v1/').url).toBe(
      'https://api.example.com/v1/pets',
    )
    expect(buildRequest(route, {}, 'https://api.example.com').url).toBe(
      'https://api.example.com/pets',
    )
  })

  it('still routes an argument for a filtered readOnly property into the body', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/widgets/{wid}': {
          put: {
            operationId: 'updateWidget',
            parameters: [
              { name: 'wid', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer', readOnly: true },
                      name: { type: 'string' },
                    },
                    required: ['name'],
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }
    const [route] = parseOpenAPIToHttpRoutes(spec)
    // The advertised schema hides the readOnly field...
    expect(
      (route.flatParamSchema.properties as Record<string, unknown>).id,
    ).toBeUndefined()
    // ...but the parameter map still routes it if a caller sends it anyway.
    const request = buildRequest(route, { wid: 'w1', name: 'n', id: 7 }, BASE)
    expect(JSON.parse(request.body as string)).toEqual({ name: 'n', id: 7 })
  })

  it('JSON-wraps a single body field when the body schema is an allOf-merged object (issue #83)', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/notifications': {
          post: {
            operationId: 'notifications_create',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [{ $ref: '#/components/schemas/notification' }],
                    required: ['body'],
                  },
                },
              },
            },
            responses: { '201': { description: 'created' } },
          },
        },
      },
      components: {
        schemas: {
          notification: {
            type: 'object',
            properties: { title: { type: 'string' }, body: { type: 'string' } },
          },
        },
      },
    }
    const [route] = parseOpenAPIToHttpRoutes(spec)
    const request = buildRequest(route, { body: 'Test' }, BASE)
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.body).toBe(JSON.stringify({ body: 'Test' }))
  })

  it('still sends an allOf-wrapped primitive body as the raw value', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/notes': {
          post: {
            operationId: 'notes_create',
            requestBody: {
              required: true,
              content: {
                'text/plain': {
                  schema: {
                    allOf: [{ $ref: '#/components/schemas/note_text' }],
                    description: 'The note text.',
                  },
                },
              },
            },
            responses: { '201': { description: 'created' } },
          },
        },
      },
      components: {
        schemas: { note_text: { type: 'string', title: 'Note Text' } },
      },
    }
    const [route] = parseOpenAPIToHttpRoutes(spec)
    // The merge finds no properties, so the flattener names the single body
    // argument 'body' (schema has no title at the top level) and the director
    // must keep sending the raw value with the declared content type.
    const request = buildRequest(route, { body: 'hello' }, BASE)
    expect(request.body).toBe('hello')
    expect(request.headers['content-type']).toBe('text/plain')
  })

  it('treats a body schema with properties but no explicit type as an object body', () => {
    const route = makeRoute({
      method: 'POST',
      requestBody: {
        required: true,
        contentSchema: {
          'application/json': {
            properties: { title: { type: 'string' }, body: { type: 'string' } },
          },
        },
      },
      parameterMap: {
        title: { location: 'body', openapiName: 'title' },
        body: { location: 'body', openapiName: 'body' },
      },
    })
    const request = buildRequest(route, { title: 'Example' }, BASE)
    expect(request.body).toBe(JSON.stringify({ title: 'Example' }))
  })
})
