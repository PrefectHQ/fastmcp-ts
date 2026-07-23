import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { FastMCP } from 'fastmcp-ts/server'

// ---------------------------------------------------------------------------
// Legacy sessionful-HTTP push routing (task-25) — DISCRIMINATING regression.
//
// A push-style server→client request (sampling/createMessage, elicitation/create)
// raised INSIDE an in-flight `tools/call` must ride that call's POST response
// stream, NOT the standalone server→client "_GET_stream". The SDK routes an
// outbound server→client request with `relatedRequestId === undefined` to the
// standalone stream, which the sessionful transport DROPS when the client has not
// opened it — a fresh GET carries no Last-Event-ID, so nothing replays. A real
// client whose first post-connect operation is a sampling/elicit tool then hangs.
//
// GET-SUPPRESSION MECHANISM: this suite hand-rolls a minimal legacy HTTP client
// over `node:http` that NEVER issues a GET on the MCP endpoint — the standalone
// "_GET_stream" is therefore never registered for this session. It drives the
// whole sampling/elicit round-trip over the POST tools/call SSE stream alone:
//   1. POST initialize (advertising the needed client capabilities), capture the
//      session id, POST notifications/initialized.
//   2. POST tools/call and read its SSE response stream incrementally.
//   3. When the server→client request arrives ON THAT POST STREAM, POST the
//      JSON-RPC response back (routed by session id).
//   4. The tool completes and the tools/call result arrives on the same stream.
//
// This deliberately does NOT use the `connectEra` era harness: that harness runs
// `awaitLegacyServerPushReady`, an attach barrier that opens/waits for the GET
// stream and would mask the very race this test proves is gone. Because the GET
// stream never exists here, the round-trip can ONLY complete if the request is
// routed onto the POST stream. Against pre-fix code the request is dropped, the
// tool hangs, and the bounded wait below rejects (RED). With the fix the routing
// carries it and both round-trips complete (GREEN).
// ---------------------------------------------------------------------------

const LEGACY_PROTOCOL_VERSION = '2025-11-25'

interface JsonRpc {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** One-shot JSON-RPC POST that reads the whole response body (no streaming). */
function bufferedPost(
  host: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<RawResponse> {
  const data = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
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

/** initialize -> capture session id -> notifications/initialized. NEVER opens a GET. */
async function handshake(
  host: string,
  port: number,
  path: string,
  capabilities: Record<string, unknown>,
): Promise<string> {
  const init = await bufferedPost(
    host,
    port,
    path,
    { 'MCP-Protocol-Version': LEGACY_PROTOCOL_VERSION },
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities,
        clientInfo: { name: 'push-routing-test', version: '1.0.0' },
      },
    },
  )
  const sessionId = init.headers['mcp-session-id'] as string
  expect(sessionId, 'server must issue a session id on initialize').toBeTruthy()
  await bufferedPost(
    host,
    port,
    path,
    { 'MCP-Protocol-Version': LEGACY_PROTOCOL_VERSION, 'Mcp-Session-Id': sessionId },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  )
  return sessionId
}

/** Split an SSE buffer, returning complete event blocks and the trailing remainder. */
function drainSseEvents(buffer: string): { messages: JsonRpc[]; rest: string } {
  const messages: JsonRpc[] = []
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? '' // last piece may be an incomplete block
  for (const block of parts) {
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data += line.slice('data:'.length).trim()
    }
    if (data.length === 0) continue // priming event (id + empty data) — no payload
    try {
      messages.push(JSON.parse(data) as JsonRpc)
    } catch {
      // ignore non-JSON keepalive/comment lines
    }
  }
  return { messages, rest }
}

/**
 * Open a tools/call POST, read its SSE stream, answer the server→client request
 * that arrives on it via `respond`, and resolve with the tools/call result.
 * Rejects if the result does not arrive within `timeoutMs` (the pre-fix hang).
 */
function callToolOverPostStream(opts: {
  host: string
  port: number
  path: string
  sessionId: string
  callId: number
  toolName: string
  respond: (req: JsonRpc) => unknown
  timeoutMs?: number
}): Promise<{ toolResult: JsonRpc; serverRequests: JsonRpc[] }> {
  const { host, port, path, sessionId, callId, toolName, respond, timeoutMs = 4000 } = opts
  const serverRequests: JsonRpc[] = []
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: callId,
    method: 'tools/call',
    params: { name: toolName, arguments: {} },
  })

  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          'MCP-Protocol-Version': LEGACY_PROTOCOL_VERSION,
          'Mcp-Session-Id': sessionId,
        },
      },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          buffer += chunk
          const { messages, rest } = drainSseEvents(buffer)
          buffer = rest
          for (const msg of messages) {
            const isServerRequest = typeof msg.method === 'string' && msg.id !== undefined
            const isCallResult =
              msg.id === callId && (msg.result !== undefined || msg.error !== undefined)
            if (isServerRequest) {
              serverRequests.push(msg)
              // Answer the server→client request. The response is POSTed on its own
              // connection and routed to the pending request by session id.
              const responseBody = {
                jsonrpc: '2.0' as const,
                id: msg.id,
                result: respond(msg),
              }
              bufferedPost(
                host,
                port,
                path,
                {
                  'MCP-Protocol-Version': LEGACY_PROTOCOL_VERSION,
                  'Mcp-Session-Id': sessionId,
                },
                responseBody,
              ).catch(() => {
                /* delivery failure surfaces as a timeout below */
              })
            } else if (isCallResult && !settled) {
              settled = true
              clearTimeout(timer)
              req.destroy()
              resolve({ toolResult: msg, serverRequests })
            }
          }
        })
      },
    )
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(
        new Error(
          `tools/call '${toolName}' did not complete within ${timeoutMs}ms — the server→client ` +
            `request was not routed onto the POST stream (received ${serverRequests.length} ` +
            `server request(s) on the stream)`,
        ),
      )
    }, timeoutMs)
    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    req.end(payload)
  })
}

describe('legacy sessionful-HTTP: push requests ride the in-flight POST stream (task-25)', () => {
  it('completes a sampling round-trip with no standalone GET stream open', async () => {
    const mcp = new FastMCP({ name: 'push-routing' })
    let samplingResult: unknown
    mcp.tool({ name: 'sampler', description: 'test' }, async () => {
      samplingResult = await mcp.getContext().sample({
        messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }],
      })
      return 'done'
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!
    try {
      const sessionId = await handshake('127.0.0.1', port, path, { sampling: {} })

      const { toolResult, serverRequests } = await callToolOverPostStream({
        host: '127.0.0.1',
        port,
        path,
        sessionId,
        callId: 2,
        toolName: 'sampler',
        respond: (reqMsg) => {
          expect(reqMsg.method).toBe('sampling/createMessage')
          return {
            role: 'assistant',
            content: { type: 'text', text: 'Hello from LLM!' },
            model: 'test-model',
            stopReason: 'endTurn',
          }
        },
      })

      // The sampling request rode the POST stream (never the standalone GET) …
      expect(serverRequests).toHaveLength(1)
      expect(serverRequests[0].method).toBe('sampling/createMessage')
      // … the tool saw the client's answer …
      expect((samplingResult as Record<string, unknown>).model).toBe('test-model')
      expect(
        ((samplingResult as Record<string, unknown>).content as Record<string, unknown>).text,
      ).toBe('Hello from LLM!')
      // … and the tools/call result came back on the same POST stream.
      expect(toolResult.error).toBeUndefined()
      const content = (toolResult.result as { content: Array<{ text: string }> }).content
      expect(content[0].text).toBe('done')
    } finally {
      await mcp.close()
    }
  })

  it('completes an elicitation round-trip with no standalone GET stream open', async () => {
    const mcp = new FastMCP({ name: 'push-routing' })
    let elicitResult: unknown
    mcp.tool({ name: 'elicitor', description: 'test' }, async () => {
      elicitResult = await mcp.getContext().elicit('Which env?', {
        type: 'object',
        properties: { env: { type: 'string', description: 'Target environment' } },
        required: ['env'],
      })
      return 'done'
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port, path } = mcp.address!
    try {
      const sessionId = await handshake('127.0.0.1', port, path, {
        elicitation: { form: {} },
      })

      const { toolResult, serverRequests } = await callToolOverPostStream({
        host: '127.0.0.1',
        port,
        path,
        sessionId,
        callId: 2,
        toolName: 'elicitor',
        respond: (reqMsg) => {
          expect(reqMsg.method).toBe('elicitation/create')
          return { action: 'accept', content: { env: 'staging' } }
        },
      })

      expect(serverRequests).toHaveLength(1)
      expect(serverRequests[0].method).toBe('elicitation/create')
      expect((elicitResult as Record<string, unknown>).action).toBe('accept')
      expect(
        ((elicitResult as Record<string, unknown>).content as Record<string, unknown>).env,
      ).toBe('staging')
      expect(toolResult.error).toBeUndefined()
      const content = (toolResult.result as { content: Array<{ text: string }> }).content
      expect(content[0].text).toBe('done')
    } finally {
      await mcp.close()
    }
  })
})
