import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { FastMCP } from 'fastmcp-ts/server'
import { BoundedEventStore } from '../../src/server/legacyEventStore.js'

// ---------------------------------------------------------------------------
// server-sse-polling (SEP-1699) — SSE resumability priming on the legacy
// (2025-era, sessionful) Streamable HTTP transport.
//
// The conformance scenario opens a POST tools/call SSE stream and asserts the
// server SHOULD:
//   1. send a priming event first — an SSE event with an `id` and empty `data`
//      (a resumption anchor the client can reconnect from via Last-Event-ID);
//   2. include a `retry` field to hint client reconnection timing.
// Both are recommended (SHOULD) for resumability; neither is a MUST.
//
// fastmcp serves 2025-era traffic through the SDK's sessionful
// `NodeStreamableHTTPServerTransport`, which emits the priming event + retry
// field only when an `eventStore` (and `retryInterval`) are configured. This
// suite drives the raw legacy wire (node:http, for the header control fetch
// forbids) and asserts the priming event on the POST SSE stream. Era scoping:
// this is legacy-HTTP behavior; the modern (2026-07-28) subscriptions/listen
// stream is a different mechanism and is not exercised here.
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** Raw JSON-RPC POST with full header control; reads the whole response body. */
function rawPost(
  connectHost: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<RawResponse> {
  const data = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: connectHost,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

/**
 * Raw GET on the MCP endpoint (the resumption / standalone SSE channel). A replay
 * GET may leave the stream open after replaying, so collect for `collectMs` then
 * tear the socket down; an error response (e.g. 400) ends on its own before that.
 */
function rawGet(
  connectHost: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  collectMs = 300,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: connectHost, port, path, method: 'GET', headers: { Accept: 'text/event-stream', ...headers } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
        res.on('end', done)
        // A long-lived SSE stream never ends on its own; stop after collecting the replay.
        setTimeout(() => {
          req.destroy()
          done()
        }, collectMs)
      },
    )
    req.on('error', (err) => {
      // `req.destroy()` above may surface as a socket error after we resolved — ignore.
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err)
    })
    req.end()
  })
}

interface SseEvent {
  id?: string
  event?: string
  data?: string
  retry?: string
}

/** Parse an SSE body into events (blocks separated by a blank line). */
function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim().length > 0 || block.includes('data:'))
    .map((block) => {
      const ev: SseEvent = {}
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) ev.id = line.slice('id:'.length).trim()
        else if (line.startsWith('event:')) ev.event = line.slice('event:'.length).trim()
        else if (line.startsWith('retry:')) ev.retry = line.slice('retry:'.length).trim()
        else if (line.startsWith('data:')) ev.data = (ev.data ?? '') + line.slice('data:'.length).trim()
      }
      return ev
    })
    .filter((ev) => ev.id !== undefined || ev.data !== undefined || ev.event !== undefined)
}

/** initialize -> capture session id -> notifications/initialized. */
async function handshake(connectHost: string, port: number, path: string): Promise<string> {
  const init = await rawPost(connectHost, port, path, { 'MCP-Protocol-Version': '2025-11-25' }, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'sse-polling-test', version: '1.0.0' },
    },
  })
  const sessionId = init.headers['mcp-session-id'] as string
  expect(sessionId, 'server must issue a session id on initialize').toBeTruthy()
  await rawPost(
    connectHost,
    port,
    path,
    { 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Session-Id': sessionId },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  )
  return sessionId
}

describe('server-sse-polling (SEP-1699) — legacy Streamable HTTP resumability', () => {
  it('sends a priming event (id + empty data) with a retry field first on a POST tools/call SSE stream', async () => {
    const mcp = new FastMCP({ name: 'sse' })
    mcp.tool({ name: 'echo', description: 'echo' }, () => 'ok')
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!
    try {
      const sessionId = await handshake('127.0.0.1', port, path)

      const res = await rawPost(
        '127.0.0.1',
        port,
        path,
        { 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Session-Id': sessionId },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } },
      )

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')

      const events = parseSse(res.body)
      // Priming event MUST be first: it carries an id + empty data (resumption anchor).
      const priming = events[0]
      expect(priming, 'stream must open with a priming event').toBeDefined()
      expect(priming.id, 'priming event carries an id').toBeTruthy()
      expect(priming.data ?? '', 'priming event has empty data').toBe('')
      // retry field hints client reconnection timing (rendered inside the priming event).
      expect(priming.retry, 'priming event carries a retry field').toBeTruthy()
      expect(Number(priming.retry)).toBeGreaterThan(0)

      // The tool result still arrives on the same stream after the priming event.
      const result = events.find((e) => e.data && e.data.includes('"id":2'))
      expect(result, 'tool response follows the priming event').toBeDefined()
    } finally {
      await mcp.close()
    }
  })

  it('replays the missed event on a GET reconnect with Last-Event-ID (end-to-end)', async () => {
    // End-to-end resumption over the real legacy wire: open a POST stream, note the
    // priming id + the stored result event, then reconnect with a standalone GET
    // carrying `Last-Event-ID: <priming id>`. The SDK routes GET to the legacy
    // transport (FastMCP `_dispatchHttp`) and replays events stored after that id —
    // proving the priming event is a working Last-Event-ID resume anchor, not decor.
    const mcp = new FastMCP({ name: 'sse-replay' })
    mcp.tool({ name: 'echo', description: 'echo' }, () => 'ok')
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!
    try {
      const sessionId = await handshake('127.0.0.1', port, path)

      const post = await rawPost(
        '127.0.0.1',
        port,
        path,
        { 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Session-Id': sessionId },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } },
      )
      const events = parseSse(post.body)
      const primingId = events[0].id!
      const resultEvent = events.find((e) => e.data && e.data.includes('"id":2'))
      expect(resultEvent?.id, 'the result event carries its own event id').toBeTruthy()

      // Reconnect from the priming id: the result event stored after it must replay.
      const replay = await rawGet('127.0.0.1', port, path, {
        'MCP-Protocol-Version': '2025-11-25',
        'Mcp-Session-Id': sessionId,
        'Last-Event-ID': primingId,
      })
      expect(replay.status).toBe(200)
      expect(replay.headers['content-type']).toContain('text/event-stream')
      const replayed = parseSse(replay.body)
      const replayedResult = replayed.find((e) => e.data && e.data.includes('"id":2'))
      expect(replayedResult, 'the missed tool result replays on reconnect').toBeDefined()
      expect(replayedResult?.id, 'replayed event keeps the same id as first delivery').toBe(
        resultEvent?.id,
      )
    } finally {
      await mcp.close()
    }
  })

  it('answers 400 for a GET reconnect with an unknown/evicted Last-Event-ID', async () => {
    // An evicted or bogus anchor is a hard error, not a silent empty replay: the
    // store returns undefined from getStreamIdForEventId and the SDK answers 400,
    // so a client can never mistake a lost prefix of events for "nothing missed".
    const mcp = new FastMCP({ name: 'sse-evicted' })
    mcp.tool({ name: 'echo', description: 'echo' }, () => 'ok')
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!
    try {
      const sessionId = await handshake('127.0.0.1', port, path)
      const replay = await rawGet('127.0.0.1', port, path, {
        'MCP-Protocol-Version': '2025-11-25',
        'Mcp-Session-Id': sessionId,
        'Last-Event-ID': 'never-issued::0::deadbeef',
      })
      expect(replay.status).toBe(400)
    } finally {
      await mcp.close()
    }
  })

  it('does not prime a pre-2025-11-25 stream (empty-SSE-data priming is version-gated)', async () => {
    // A 2025-06-18 client negotiates a version below the empty-SSE-data fix, so the
    // SDK transport must NOT emit an empty-data priming event (older clients would
    // mis-parse it). This keeps the enablement scoped to versions that support it.
    const mcp = new FastMCP({ name: 'sse-old' })
    mcp.tool({ name: 'echo', description: 'echo' }, () => 'ok')
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!
    try {
      const init = await rawPost('127.0.0.1', port, path, { 'MCP-Protocol-Version': '2025-06-18' }, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'old', version: '1.0.0' },
        },
      })
      const sessionId = init.headers['mcp-session-id'] as string
      await rawPost(
        '127.0.0.1',
        port,
        path,
        { 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Session-Id': sessionId },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      )
      const res = await rawPost(
        '127.0.0.1',
        port,
        path,
        { 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Session-Id': sessionId },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } },
      )
      const events = parseSse(res.body)
      // No empty-data priming event: the first (only) event is the tool result.
      const primingLike = events.find((e) => e.id !== undefined && (e.data ?? '') === '')
      expect(primingLike, 'no version-gated priming event for a pre-2025-11-25 client').toBeUndefined()
      // Wider wire change: `storeEvent` is NOT version-gated, so the result event
      // still carries an `id:` even for an older client. This is spec-safe — `id`
      // is a core SSE field older clients already tolerate — and it is what lets
      // such a client resume via Last-Event-ID; only the empty-data priming event
      // (which older clients could mis-parse) is withheld below 2025-11-25.
      const result = events.find((e) => e.data && e.data.includes('"id":2'))
      expect(result?.id, 'result event carries an id even for a pre-2025-11-25 client').toBeTruthy()
    } finally {
      await mcp.close()
    }
  })
})

describe('BoundedEventStore — bounded-memory resumability (SEP-1699)', () => {
  it('evicts oldest events FIFO beyond the cap so retention is bounded', async () => {
    const store = new BoundedEventStore(3)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(await store.storeEvent('s1', { jsonrpc: '2.0', method: `n${i}` }))
    }
    // The two oldest ids were evicted; only the newest 3 remain resolvable.
    expect(await store.getStreamIdForEventId(ids[0])).toBeUndefined()
    expect(await store.getStreamIdForEventId(ids[1])).toBeUndefined()
    expect(await store.getStreamIdForEventId(ids[2])).toBe('s1')
    expect(await store.getStreamIdForEventId(ids[4])).toBe('s1')
  })

  it('replays only the events after the anchor, in order, for the same stream', async () => {
    const store = new BoundedEventStore(16)
    const a = await store.storeEvent('sA', { jsonrpc: '2.0', method: 'a' })
    await store.storeEvent('sA', { jsonrpc: '2.0', method: 'b' })
    await store.storeEvent('sB', { jsonrpc: '2.0', method: 'other' }) // different stream — must be skipped
    await store.storeEvent('sA', { jsonrpc: '2.0', method: 'c' })

    const replayed: string[] = []
    const streamId = await store.replayEventsAfter(a, {
      send: async (_id, msg) => {
        replayed.push((msg as { method: string }).method)
      },
    })
    expect(streamId).toBe('sA')
    expect(replayed).toEqual(['b', 'c'])
  })

  it('returns an empty stream id for an unknown/evicted anchor (nothing to replay)', async () => {
    const store = new BoundedEventStore(4)
    const sent: string[] = []
    const streamId = await store.replayEventsAfter('does-not-exist', {
      send: async (id) => {
        sent.push(id)
      },
    })
    expect(streamId).toBe('')
    expect(sent).toEqual([])
  })
})
