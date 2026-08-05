import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOpenAPIServer } from 'fastmcp-ts/server'
import type { FastMCP, RouteMap } from 'fastmcp-ts/server'
import { createTestClient } from '../../helpers/createTestClient'
import type { TestClient } from '../../helpers/createTestClient'

interface CapturedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** Tiny upstream API the generated server calls. */
function makeStub() {
  const requests: CapturedRequest[] = []

  const handler = (req: IncomingMessage, res: ServerResponse, body: string): void => {
    const url = new URL(req.url as string, 'http://stub')
    requests.push({
      method: req.method as string,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    })

    const respondJson = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }

    switch (url.pathname.replace(/^\/(\d+)$/, '/:id')) {
      case '/objects/42':
        respondJson(200, { id: 42, ok: true })
        return
      case '/list':
        respondJson(200, ['a', 'b'])
        return
      case '/anon':
        respondJson(200, [1, 2, 3])
        return
      case '/text':
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('plain result')
        return
      case '/scalar':
        respondJson(200, 42)
        return
      case '/error':
        respondJson(404, { detail: 'missing' })
        return
      case '/slow':
        setTimeout(() => respondJson(200, { late: true }), 500)
        return
      case '/echo':
        respondJson(200, JSON.parse(body || 'null'))
        return
      case '/form':
      case '/upload':
        respondJson(200, { received: body.length > 0 })
        return
      case '/res-json':
        respondJson(200, { kind: 'json resource' })
        return
      case '/res-csv':
        res.writeHead(200, { 'content-type': 'text/csv' })
        res.end('a,b\n1,2\n')
        return
      case '/res-bin':
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.from([1, 2, 3]))
        return
      case '/items/5':
        respondJson(200, { itemId: 5 })
        return
      default:
        respondJson(500, { unexpected: url.pathname })
    }
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')))
  })

  return {
    requests,
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no address')
      return `http://127.0.0.1:${address.port}`
    },
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    },
    lastRequest(): CapturedRequest {
      if (requests.length === 0) throw new Error('no requests captured')
      return requests[requests.length - 1]
    },
  }
}

const RUNTIME_SPEC: Record<string, unknown> = {
  openapi: '3.1.0',
  info: { title: 'Runtime', version: '1.0.0' },
  paths: {
    '/objects/{id}': {
      get: {
        operationId: 'getObject',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'integer' }, ok: { type: 'boolean' } },
                },
              },
            },
          },
        },
      },
    },
    '/list': {
      get: {
        operationId: 'getList',
        parameters: [
          {
            name: 'ids',
            in: 'query',
            schema: { type: 'array', items: { type: 'integer' } },
          },
          { name: 'flag', in: 'query', schema: { type: 'boolean' } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
    '/anon': {
      get: { operationId: 'getAnon', responses: { '204': { description: 'no schema' } } },
    },
    '/text': {
      get: {
        operationId: 'getText',
        responses: {
          '200': {
            description: 'ok',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/scalar': {
      get: {
        operationId: 'getScalar',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'integer' } } },
          },
        },
      },
    },
    '/error': {
      get: { operationId: 'getError', responses: { '200': { description: 'never' } } },
    },
    '/slow': {
      get: { operationId: 'getSlow', responses: { '200': { description: 'slow' } } },
    },
    '/echo': {
      post: {
        operationId: 'postEcho',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { a: { type: 'string' }, n: { type: 'integer' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/form': {
      post: {
        operationId: 'postForm',
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: { a: { type: 'string' }, b: { type: 'boolean' } },
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
    '/upload': {
      post: {
        operationId: 'postUpload',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  file: { type: 'string', format: 'binary' },
                  label: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
    '/res-json': {
      get: {
        operationId: 'resJson',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/res-csv': {
      get: {
        operationId: 'resCsv',
        responses: {
          '200': {
            description: 'ok',
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/res-bin': {
      get: {
        operationId: 'resBin',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
        },
      },
    },
    '/items/{itemId}': {
      get: {
        operationId: 'getItem',
        parameters: [
          { name: 'itemId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
}

const RESOURCE_MAPS: RouteMap[] = [
  { methods: ['GET'], pattern: '^/res-', mcpType: 'resource' },
  { methods: ['GET'], pattern: '^/items/', mcpType: 'resourceTemplate' },
]

describe('OpenAPI runtime over the MCP wire', () => {
  const stub = makeStub()
  let mcp: FastMCP
  let tc: TestClient

  beforeAll(async () => {
    const baseUrl = await stub.listen()
    mcp = createOpenAPIServer({
      spec: RUNTIME_SPEC,
      routeMaps: RESOURCE_MAPS,
      client: {
        baseUrl,
        timeoutMs: 150,
        headers: { 'x-default': 'client', 'x-trace': 'default-trace' },
        auth: { getHeaders: async () => ({ authorization: 'Bearer secret-token' }) },
      },
    })
    tc = await createTestClient(mcp)
  })

  afterAll(async () => {
    await tc.close()
    await stub.close()
  })

  async function call(name: string, args: Record<string, unknown> = {}) {
    return tc.client.callTool({ name, arguments: args })
  }

  it('returns JSON object responses as structuredContent', async () => {
    const result = await call('getObject', { id: 42 })
    expect(result.isError ?? false).toBe(false)
    expect(result.structuredContent).toEqual({ id: 42, ok: true })
    expect(stub.lastRequest()).toMatchObject({ method: 'GET', path: '/objects/42' })
  })

  it('wraps array responses per the x-fastmcp-wrap-result marker', async () => {
    const result = await call('getList')
    expect(result.structuredContent).toEqual({ result: ['a', 'b'] })
  })

  it('wraps non-object JSON when no output schema exists', async () => {
    const result = await call('getAnon')
    expect(result.structuredContent).toEqual({ result: [1, 2, 3] })
  })

  it('wraps scalar JSON responses', async () => {
    const result = await call('getScalar')
    expect(result.structuredContent).toEqual({ result: 42 })
  })

  it('returns non-JSON responses as plain text', async () => {
    const result = await call('getText')
    expect(result.structuredContent).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'plain result' }])
  })

  it('sends query, header, auth, and default headers correctly', async () => {
    await call('getList', { ids: [1, 2], flag: true, 'X-Trace': 'from-arg' })
    const request = stub.lastRequest()
    expect(request.query.getAll('ids')).toEqual(['1', '2'])
    expect(request.query.get('flag')).toBe('true')
    // Client default headers ride along; per-request parameter headers win.
    expect(request.headers['x-default']).toBe('client')
    expect(request.headers['x-trace']).toBe('from-arg')
    expect(request.headers.authorization).toBe('Bearer secret-token')
  })

  it('sends JSON bodies with the right content type', async () => {
    const result = await call('postEcho', { a: 'x', n: 7 })
    expect(result.structuredContent).toEqual({ a: 'x', n: 7 })
    const request = stub.lastRequest()
    expect(request.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request.body)).toEqual({ a: 'x', n: 7 })
  })

  it('sends urlencoded bodies', async () => {
    await call('postForm', { a: 'x', b: true })
    const request = stub.lastRequest()
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
    expect(request.body).toBe('a=x&b=true')
  })

  it('sends multipart bodies', async () => {
    await call('postUpload', { file: 'bytes', label: 'tag' })
    const request = stub.lastRequest()
    expect(request.headers['content-type']).toContain('multipart/form-data')
    expect(request.body).toContain('name="label"')
    expect(request.body).toContain('tag')
  })

  it('maps HTTP errors to Python-compatible tool errors', async () => {
    const result = await call('getError')
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain('HTTP error 404: Not Found')
    expect(text).toContain('{"detail":"missing"}')
  })

  it('maps timeouts to a timed-out tool error', async () => {
    const result = await call('getSlow')
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain(
      'HTTP request timed out (TimeoutError)',
    )
  })

  it('reads JSON resources', async () => {
    const result = await tc.client.readResource({ uri: 'resource://resJson' })
    expect(result.contents).toEqual([
      {
        uri: 'resource://resJson',
        mimeType: 'application/json',
        text: JSON.stringify({ kind: 'json resource' }),
      },
    ])
  })

  it('reads text resources with the declared MIME type', async () => {
    const result = await tc.client.readResource({ uri: 'resource://resCsv' })
    expect(result.contents).toEqual([
      { uri: 'resource://resCsv', mimeType: 'text/csv', text: 'a,b\n1,2\n' },
    ])
  })

  it('reads binary resources as base64 blobs', async () => {
    const result = await tc.client.readResource({ uri: 'resource://resBin' })
    expect(result.contents).toEqual([
      {
        uri: 'resource://resBin',
        mimeType: 'application/octet-stream',
        blob: Buffer.from([1, 2, 3]).toString('base64'),
      },
    ])
  })

  it('reads resource templates with path parameters routed to the HTTP path', async () => {
    const result = await tc.client.readResource({ uri: 'resource://getItem/5' })
    expect(result.contents).toEqual([
      {
        uri: 'resource://getItem/5',
        mimeType: 'application/json',
        text: JSON.stringify({ itemId: 5 }),
      },
    ])
    expect(stub.lastRequest()).toMatchObject({ method: 'GET', path: '/items/5' })
  })
})

describe('connection failures', () => {
  it('maps connection errors to a request-error tool error', async () => {
    const mcp = createOpenAPIServer({
      spec: {
        openapi: '3.1.0',
        info: { title: 'X', version: '1' },
        paths: {
          '/x': { get: { operationId: 'getX', responses: { '200': { description: 'ok' } } } },
        },
      },
      client: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 },
    })
    const { client, close } = await createTestClient(mcp)
    try {
      const result = await client.callTool({ name: 'getX' })
      expect(result.isError).toBe(true)
      expect((result.content as Array<{ text: string }>)[0].text).toContain('Request error (')
    } finally {
      await close()
    }
  })
})
