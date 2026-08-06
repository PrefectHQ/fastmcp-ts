import { afterEach, describe, expect, it } from 'vitest'
import { FastMCP } from 'fastmcp-ts/server'
import type { AuthInfo, McpHandlerRequestOptions } from 'fastmcp-ts/server'

const LEGACY = '2025-11-25'
const MODERN = '2026-07-28'
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities'
const URL = 'https://example.test/mcp'

const servers = new Set<FastMCP>()

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close().catch(() => {})))
  servers.clear()
})

function createServer(): FastMCP {
  const server = new FastMCP({ name: 'fetch-test', version: '1.0.0' })
  servers.add(server)
  return server
}

function legacyRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function envelope(capabilities: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_CAPABILITIES_META_KEY]: capabilities,
  }
}

function modernRequest(
  method: string,
  params: Record<string, unknown>,
  options: {
    id?: number
    name?: string
    signal?: AbortSignal
    meta?: Record<string, unknown>
  } = {},
): Request {
  const message = {
    jsonrpc: '2.0',
    ...(options.id === undefined ? {} : { id: options.id }),
    method,
    params: { ...params, _meta: { ...envelope(), ...options.meta } },
  }
  return new Request(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': method,
      ...(options.name ? { 'Mcp-Name': options.name } : {}),
    },
    body: JSON.stringify(message),
    signal: options.signal,
  })
}

interface RpcBody {
  jsonrpc?: string
  id?: unknown
  method?: string
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

async function rpcBody(response: Response): Promise<RpcBody> {
  const text = await response.text()
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(text) as RpcBody
  }
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
  return JSON.parse(data[data.length - 1]) as RpcBody
}

function createSseReader(stream: ReadableStream<Uint8Array>): {
  reader: ReadableStreamDefaultReader<Uint8Array>
  next(): Promise<RpcBody>
} {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ''

  return {
    reader,
    async next() {
      while (true) {
        const boundary = buffered.indexOf('\n\n')
        if (boundary !== -1) {
          const frame = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n')
          if (data) return JSON.parse(data) as RpcBody
          continue
        }

        const { done, value } = await reader.read()
        if (done) throw new Error('SSE stream ended before the next data event')
        buffered += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      }
    },
  }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LEGACY,
    capabilities: {},
    clientInfo: { name: 'fetch-client', version: '1.0.0' },
  },
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

describe('FastMCP.fetch', () => {
  it('serves a 2025-era initialize and request exchange without run()', async () => {
    const server = createServer()
    server.tool({ name: 'ping', description: 'Return pong' }, () => 'pong')

    const initialized = await server.fetch(legacyRequest(INITIALIZE))
    expect(initialized.status).toBe(200)
    expect((await rpcBody(initialized)).result).toBeDefined()
    expect(initialized.headers.get('mcp-session-id')).toBeNull()

    const listed = await server.fetch(legacyRequest(TOOLS_LIST))
    expect(listed.status).toBe(200)
    expect((await rpcBody(listed)).result?.tools).toEqual([
      expect.objectContaining({ name: 'ping' }),
    ])
    expect(server.address).toBeNull()
  })

  it('serves a 2026-07-28 request through the modern server configuration', async () => {
    const server = createServer()
    server.tool({ name: 'ping', description: 'Return pong' }, () => 'pong')

    const response = await server.fetch(modernRequest('server/discover', {}, { id: 1 }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await rpcBody(response)
    const capabilities = body.result?.capabilities as {
      tools?: Record<string, unknown>
      resources?: Record<string, unknown>
    }
    expect(capabilities.tools).toBeDefined()
    expect(capabilities.resources?.subscribe).toBeUndefined()
  })

  it('returns the SDK stateless legacy 405 response for GET and DELETE', async () => {
    const server = createServer()

    for (const method of ['GET', 'DELETE']) {
      const response = await server.fetch(new Request(URL, { method }))
      expect(response.status).toBe(405)
      expect((await response.json()).error).toMatchObject({
        code: -32000,
        message: 'Method not allowed.',
      })
    }
  })

  it('accepts legacy and modern notifications', async () => {
    const server = createServer()

    const legacy = await server.fetch(
      legacyRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )
    expect(legacy.status).toBe(202)

    const modern = await server.fetch(
      modernRequest(
        'notifications/cancelled',
        { requestId: 123, reason: 'test complete' },
      ),
    )
    expect(modern.status).toBe(202)
  })

  it('passes trusted authInfo through to the FastMCP context', async () => {
    const server = createServer()
    let received: ReturnType<FastMCP['getContext']>['auth'] = undefined
    server.tool({ name: 'whoami', description: 'Capture auth' }, () => {
      received = server.getContext().auth
      return 'ok'
    })
    const authInfo: AuthInfo = {
      token: 'validated-token',
      clientId: 'framework-client',
      scopes: ['tools:call'],
      expiresAt: 1_900_000_000,
      extra: { tenant: 'acme' },
    }

    const response = await server.fetch(
      legacyRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
      { authInfo },
    )
    expect(response.status).toBe(200)
    expect((await rpcBody(response)).error).toBeUndefined()
    expect(received).toEqual({
      token: 'validated-token',
      clientId: 'framework-client',
      scopes: ['tools:call'],
      expiresAt: 1_900_000_000,
      claims: { tenant: 'acme' },
    })
  })

  it('uses parsedBody after framework middleware consumed the Request body', async () => {
    const server = createServer()
    server.tool({ name: 'ping', description: 'Return pong' }, () => 'pong')
    const parsedBody = TOOLS_LIST
    const request = legacyRequest(parsedBody)
    await request.text()

    const options: McpHandlerRequestOptions = { parsedBody }
    const response = await server.fetch(request, options)
    expect(response.status).toBe(200)
    expect((await rpcBody(response)).result?.tools).toEqual([
      expect.objectContaining({ name: 'ping' }),
    ])
  })

  it('rejects non-JSON POST content types before era classification', async () => {
    const server = createServer()
    const response = await server.fetch(
      new Request(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(INITIALIZE),
      }),
    )

    expect(response.status).toBe(415)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      error: 'Unsupported Media Type: expected application/json',
    })
  })

  it('keeps invalid modern requests on the modern validation path', async () => {
    const server = createServer()
    const response = await server.fetch(
      legacyRequest(TOOLS_LIST, {
        'MCP-Protocol-Version': MODERN,
        'Mcp-Method': 'tools/list',
      }),
    )
    const body = await rpcBody(response)

    expect(response.status).toBe(400)
    expect(body.error?.code).toBe(-32602)
    expect(body.error?.message).toMatch(/envelope|_meta/i)
  })

  it('preserves an SSE response body for a streaming modern exchange', async () => {
    const server = createServer()
    server.tool({ name: 'stream', description: 'Log before returning' }, async () => {
      await server.getContext().info('working')
      return 'done'
    })

    const response = await server.fetch(
      modernRequest(
        'tools/call',
        { name: 'stream', arguments: {} },
        {
          id: 1,
          name: 'stream',
          meta: { 'io.modelcontextprotocol/logLevel': 'debug' },
        },
      ),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('notifications/message')
    expect(text).toContain('done')
  })

  it('shares the modern notification bus and closes active fetch streams', async () => {
    const server = createServer()
    const response = await server.fetch(
      modernRequest(
        'subscriptions/listen',
        { notifications: { toolsListChanged: true } },
        { id: 7 },
      ),
    )
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const events = createSseReader(response.body!)
    expect((await events.next()).method).toBe('notifications/subscriptions/acknowledged')

    server.tool({ name: 'added_after_listen', description: 'Trigger list change' }, () => 'ok')
    expect((await events.next()).method).toBe('notifications/tools/list_changed')

    await server.close()
    servers.delete(server)
    const streamEnded = (async () => {
      while (!(await events.reader.read()).done) {
        // Drain frames that were already queued when close() aborted the stream.
      }
      return true
    })()
    await expect(
      Promise.race([
        streamEnded,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]),
    ).resolves.toBe(true)
  })

  it('uses fresh legacy state for every fetch request', async () => {
    const server = createServer()
    server.tool({ name: 'ping', description: 'Return pong' }, () => 'pong')

    for (const sessionId of ['from-instance-a', 'from-instance-b']) {
      const response = await server.fetch(
        legacyRequest(TOOLS_LIST, { 'mcp-session-id': sessionId }),
      )
      expect(response.status).toBe(200)
      expect((await rpcBody(response)).result?.tools).toEqual([
        expect.objectContaining({ name: 'ping' }),
      ])
      expect(response.headers.get('mcp-session-id')).toBeNull()
    }

    const sessions = (server as unknown as { _sessions: Map<string, unknown> })._sessions
    expect(sessions.size).toBe(0)
  })

  it('does not change run() defaulting legacy HTTP to sessionful serving', async () => {
    const server = createServer()
    await server.run({ transport: 'http', host: '127.0.0.1', port: 0 })
    const address = server.address!
    const url = `http://127.0.0.1:${address.port}${address.path}`

    const initialized = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(INITIALIZE),
    })
    expect(initialized.headers.get('mcp-session-id')).toBeTruthy()

    const unknownSession = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': 'not-a-real-session',
      },
      body: JSON.stringify(TOOLS_LIST),
    })
    expect(unknownSession.status).toBe(404)
  })
})
