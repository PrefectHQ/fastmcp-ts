import { describe, it, expect, afterEach } from 'vitest'
import { FastMCP, inputRequired, acceptedContent } from 'fastmcp-ts/server'
import { stdioPipePair } from '../helpers/stdio'

afterEach(() => {
  delete process.env.FASTMCP_STATELESS_HTTP
})

/** Reads the private flag. Deliberate: there is no public accessor and the
 *  resolution order is the contract this suite is pinning. */
function statelessFlag(mcp: FastMCP): boolean {
  return (mcp as unknown as { _stateless: boolean })._stateless
}

describe('stateless flag resolution', () => {
  it('defaults to false', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    expect(statelessFlag(mcp)).toBe(false)
    await mcp.close()
  })

  it('reads FASTMCP_STATELESS_HTTP', async () => {
    process.env.FASTMCP_STATELESS_HTTP = 'true'
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    expect(statelessFlag(mcp)).toBe(true)
    await mcp.close()
  })

  it('lets RunOptions.stateless beat the environment variable', async () => {
    process.env.FASTMCP_STATELESS_HTTP = 'true'
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: false })
    expect(statelessFlag(mcp)).toBe(false)
    await mcp.close()
  })

  it('throws at startup on a malformed environment variable', async () => {
    process.env.FASTMCP_STATELESS_HTTP = 'ture'
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    await expect(mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })).rejects.toThrow(
      /FASTMCP_STATELESS_HTTP/,
    )
  })

  // Resolution happens before the stdio/http branch in run(), so a malformed
  // value must reject stdio startup too, not just http. Pins that on purpose:
  // see FastMCP.ts run()'s comment ("Resolved for every transport...").
  it('throws at startup on a malformed environment variable for the stdio transport', async () => {
    process.env.FASTMCP_STATELESS_HTTP = 'ture'
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    const { clientToServer, serverToClient } = stdioPipePair()
    await expect(
      mcp.run({ transport: 'stdio', stdin: clientToServer, stdout: serverToClient }),
    ).rejects.toThrow(/FASTMCP_STATELESS_HTTP/)
    await mcp.close()
  })
})

const LEGACY_PROTOCOL_VERSION = '2025-11-25'

async function startStateless(): Promise<FastMCP> {
  const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
  mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')
  await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })
  return mcp
}

function urlFor(mcp: FastMCP): string {
  const a = mcp.address!
  return `http://127.0.0.1:${a.port}${a.path}`
}

async function post(url: string, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  })
}

/**
 * Parses a legacy HTTP JSON-RPC response body, whether the transport buffered it as
 * a bare JSON object or streamed it as SSE. A sessionful SSE stream opens with a
 * keep-alive/reconnect event (empty `data:`) before the real one, so this takes the
 * LAST `data:` line, matching parseLastSseData in tests/wire/golden.test.ts.
 */
function parseRpcBody(text: string): { result?: any; error?: any } {
  const line = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .pop()!
        .slice(5)
  return JSON.parse(line)
}

/** Reads and parses a Response's body via {@link parseRpcBody}. Status and headers
 *  alone do not prove a legacy request succeeded — a 200 can still carry a JSON-RPC
 *  `error` — so callers that care about the actual outcome should check the body. */
async function rpcBody(res: Response): Promise<{ result?: any; error?: any }> {
  return parseRpcBody(await res.text())
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

describe('stateless dispatch', () => {
  it('serves a request carrying a session id the server never issued', async () => {
    const mcp = await startStateless()
    const url = urlFor(mcp)

    const init = await post(url, INITIALIZE)
    expect(init.status).toBe(200)
    // Status and headers alone don't prove this succeeded: a 200 can still carry a
    // JSON-RPC error body, which is exactly what a stub answering "200 always" would
    // pass. Parse the body and check for a real result.
    const initBody = await rpcBody(init)
    expect(initBody.error).toBeUndefined()
    expect(initBody.result).toBeDefined()

    // The exact production failure: a session id from another instance, or
    // one a proxy fabricated. Sessionful mode answers 404 here.
    const listed = await post(url, TOOLS_LIST, 'a-session-this-server-never-issued')
    expect(listed.status).toBe(200)
    const listedBody = await rpcBody(listed)
    expect(listedBody.error).toBeUndefined()
    // Not just "a result" -- the actual registered tool, so a handler wired to the
    // wrong instance (or a stub returning an empty list) would fail this too.
    expect(listedBody.result?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ping' })]),
    )

    await mcp.close()
  })

  it('issues no mcp-session-id', async () => {
    const mcp = await startStateless()
    const init = await post(urlFor(mcp), INITIALIZE)
    expect(init.headers.get('mcp-session-id')).toBeNull()
    const initBody = await rpcBody(init)
    expect(initBody.error).toBeUndefined()
    expect(initBody.result).toBeDefined()
    await mcp.close()
  })

  it('never populates the session registry', async () => {
    const mcp = await startStateless()
    const url = urlFor(mcp)
    for (let i = 0; i < 5; i++) {
      const res = await post(url, INITIALIZE)
      // The registry assertion below is vacuous if every request errored out
      // before reaching session bookkeeping -- confirm each one actually succeeded.
      expect(res.status).toBe(200)
      const body = await rpcBody(res)
      expect(body.error).toBeUndefined()
      expect(body.result).toBeDefined()
    }
    const sessions = (mcp as unknown as { _sessions: Map<string, unknown> })._sessions
    expect(sessions.size).toBe(0)
    await mcp.close()
  })

  it('rejects GET and DELETE with 405', async () => {
    const mcp = await startStateless()
    const url = urlFor(mcp)
    const get = await fetch(url, { method: 'GET', headers: { Accept: 'text/event-stream' } })
    expect(get.status).toBe(405)
    const del = await fetch(url, { method: 'DELETE' })
    expect(del.status).toBe(405)
    await mcp.close()
  })
})

describe('sessionful mode is unchanged', () => {
  it('still 404s an unknown session id', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const res = await post(urlFor(mcp), TOOLS_LIST, 'nope')
    expect(res.status).toBe(404)
    await mcp.close()
  })

  it('still serves GET', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const res = await fetch(urlFor(mcp), {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    })
    expect(res.status).not.toBe(405)
    await mcp.close()
  })
})

async function initializeResult(url: string): Promise<Record<string, any>> {
  const res = await post(url, INITIALIZE)
  return (await rpcBody(res)).result
}

describe('stateless subscribe', () => {
  it('does not advertise resources.subscribe', async () => {
    const mcp = await startStateless()
    const result = await initializeResult(urlFor(mcp))
    expect(result.capabilities.resources.subscribe).toBeUndefined()
    expect(result.capabilities.resources.listChanged).toBe(true)
    await mcp.close()
  })

  it('still advertises resources.subscribe when stateless is off', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const result = await initializeResult(urlFor(mcp))
    expect(result.capabilities.resources.subscribe).toBe(true)
    await mcp.close()
  })

  it('rejects resources/subscribe from a non-compliant client', async () => {
    const mcp = await startStateless()
    const res = await post(urlFor(mcp), {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/subscribe',
      params: { uri: 'file:///anything' },
    })
    const body = await rpcBody(res)
    // "stateless" alone isn't specific to this guard -- the session-state error
    // (see below) also contains it, so it would pass even if subscribe fell through
    // to that unrelated rejection. Pin the JSON-RPC error code (-32601, MethodNotFound,
    // per STATELESS_SUBSCRIBE_ERROR in FastMCP.ts) and a phrase unique to the subscribe
    // guard's own message.
    expect(body.error?.code).toBe(-32601)
    expect(body.error?.message).toContain(
      'resources/subscribe and resources/unsubscribe are unavailable on a stateless HTTP server',
    )
    await mcp.close()
  })
})

describe('stateless session state', () => {
  it('throws a pointed error naming the switch', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    mcp.tool({ name: 'remember', description: 'writes session state' }, () => {
      mcp.getContext().setState('k', 'v')
      return 'ok'
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })

    const res = await post(urlFor(mcp), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'remember', arguments: {} },
    })
    const text = await res.text()
    expect(text).toContain('FASTMCP_STATELESS_HTTP')
    expect(text).not.toContain('2026-07-28')

    await mcp.close()
  })

  it('still stores session state when stateless is off', async () => {
    // Sentinel: distinctive enough that it cannot appear in the response
    // envelope by accident (unlike a single character such as 'v', which also
    // matches the letter in "Server" -- see fix-round-1 note in the report).
    const SENTINEL = 'sentinel-9f3c2a7d-remembered-value'
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    mcp.tool({ name: 'remember', description: 'writes session state' }, () => {
      const ctx = mcp.getContext()
      ctx.setState('k', SENTINEL)
      return String(ctx.getState('k'))
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const url = urlFor(mcp)

    // A bare tools/call with no prior initialize is rejected pre-handler by
    // the sessionful transport ("Server not initialized") -- the tool never
    // runs. Drive a real initialize first and thread the returned session id,
    // the same shape as the elicit-capability control above, so this test
    // actually exercises the round trip it claims to guard.
    const init = await post(url, INITIALIZE)
    const sessionId = init.headers.get('mcp-session-id')!

    const res = await post(
      url,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'remember', arguments: {} },
      },
      sessionId,
    )
    expect(await res.text()).toContain(SENTINEL)
    await mcp.close()
  })
})

describe('stateless server-initiated request guards', () => {
  it('ctx.elicit throws a pointed error naming the switch', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    mcp.tool({ name: 'elicitor', description: 'calls ctx.elicit' }, async () => {
      await mcp.getContext().elicit('Which env?', { type: 'object', properties: {} })
      return 'ok'
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })

    const res = await post(urlFor(mcp), {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'elicitor', arguments: {} },
    })
    const text = await res.text()
    expect(text).toContain('FASTMCP_STATELESS_HTTP')
    expect(text).not.toContain('Client does not support')

    await mcp.close()
  })

  it('ctx.sample throws a pointed error naming the switch', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    mcp.tool({ name: 'sampler', description: 'calls ctx.sample' }, async () => {
      await mcp.getContext().sample({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] })
      return 'ok'
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })

    const res = await post(urlFor(mcp), {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'sampler', arguments: {} },
    })
    const text = await res.text()
    expect(text).toContain('FASTMCP_STATELESS_HTTP')
    expect(text).not.toContain('Client does not support')

    await mcp.close()
  })

  it('ctx.listRoots throws a pointed error naming the switch', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    mcp.tool({ name: 'rootser', description: 'calls ctx.listRoots' }, async () => {
      await mcp.getContext().listRoots()
      return 'ok'
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })

    const res = await post(urlFor(mcp), {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'rootser', arguments: {} },
    })
    const text = await res.text()
    expect(text).toContain('FASTMCP_STATELESS_HTTP')
    expect(text).not.toContain('Client does not support')

    await mcp.close()
  })

  it('still fires the client-capability error for ctx.elicit when stateless is off (sessionful legacy, unchanged)', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    mcp.tool({ name: 'elicitor', description: 'calls ctx.elicit' }, async () => {
      await mcp.getContext().elicit('Which env?', { type: 'object', properties: {} })
      return 'ok'
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const url = urlFor(mcp)

    const init = await post(url, INITIALIZE)
    const sessionId = init.headers.get('mcp-session-id')!

    const res = await post(
      url,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'elicitor', arguments: {} },
      },
      sessionId,
    )
    const text = await res.text()
    expect(text).toContain('Client does not support elicitation')
    expect(text).not.toContain('FASTMCP_STATELESS_HTTP')

    await mcp.close()
  })
})

/** Sums a large array a few items at a time, carrying position and running
 *  total in `requestState` -- the same shape as the sumChunked example in
 *  docs/concepts/input-required.mdx#the-requeststate-only-pattern. Returns a
 *  sentinel-tagged result so a passing assertion proves the handler actually
 *  re-entered enough rounds to consume the whole array and read its state
 *  back correctly, not just that some result came back. */
function registerChunkedSum(mcp: FastMCP, sentinel: string): void {
  mcp.tool({ name: 'sumChunked', description: 'sum a large array a few items at a time' }, async (args: Record<string, unknown>) => {
    const items = args.items as number[]
    const CHUNK = 2
    const ctx = mcp.getContext()
    const state = ctx.requestState<{ index: number; total: number }>()
    const index = state?.index ?? 0
    const total = state?.total ?? 0
    const next = items.slice(index, index + CHUNK).reduce((sum, n) => sum + n, total)
    const nextIndex = index + CHUNK
    if (nextIndex < items.length) {
      return inputRequired({ requestState: await ctx.mintRequestState({ index: nextIndex, total: next }) })
    }
    return `${sentinel}:${next}`
  })
}

describe('stateless requestState-only pattern', () => {
  it('re-enters the handler across rounds and reads requestState back, with FastMCPOptions.requestState configured', async () => {
    // Sentinel proves the handler actually re-entered and completed with state
    // read back correctly (28 = 1+2+...+7), not just that some result came back.
    const SENTINEL = 'sentinel-3d9f1c-chunked-sum'
    const mcp = new FastMCP({ name: 'test', version: '0.0.0', requestState: { key: 'x'.repeat(32) } })
    registerChunkedSum(mcp, SENTINEL)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })
    const url = urlFor(mcp)

    await post(url, INITIALIZE)
    const res = await post(url, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      // 7 items, CHUNK 2 -> 4 rounds needed to exhaust the array.
      params: { name: 'sumChunked', arguments: { items: [1, 2, 3, 4, 5, 6, 7] } },
    })
    const body = await rpcBody(res)
    expect(body.error).toBeUndefined()
    expect(body.result?.content?.[0]?.text).toBe(`${SENTINEL}:28`)

    await mcp.close()
  })

  it('never advances without FastMCPOptions.requestState configured, and fails once maxRounds is spent', async () => {
    // Without a configured verify hook, ctx.requestState() hands back the raw
    // minted string, not the parsed object -- index/total never advance, so
    // this must fail via the rounds-exceeded path, not succeed some other way.
    const SENTINEL = 'sentinel-should-never-appear'
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    registerChunkedSum(mcp, SENTINEL)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })
    const url = urlFor(mcp)

    await post(url, INITIALIZE)
    const res = await post(url, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'sumChunked', arguments: { items: [1, 2, 3, 4, 5, 6, 7] } },
    })
    const body = await rpcBody(res)
    expect(body.result?.content?.[0]?.text).not.toContain(SENTINEL)
    expect(body.result?.isError).toBe(true)
    expect(body.result?.content?.[0]?.text).toContain('still required input after 8 rounds')

    await mcp.close()
  }, 15_000)
})

/** Registers a tool that returns inputRequired({ inputRequests }) until the client supplies
 *  `confirm: true` -- the same shape as the deploy-confirmation example in
 *  docs/concepts/input-required.mdx. Shared by the direct guard test below and the mounted-child
 *  guard test in the "stateless mount()" describe block further down, so both exercise the exact
 *  same handler shape. `mcp` is registered on directly here; the mount test instead passes the
 *  mounted child, so the tool lives on the child and `getContext()`/`inputResponses` inside the
 *  handler still resolve correctly via the shared AsyncLocalStorage-backed context. */
function registerAskConfirmation(mcp: FastMCP): void {
  mcp.tool({ name: 'ask', description: 'ask via inputRequired({ inputRequests })' }, async () => {
    const ctx = mcp.getContext()
    const accepted = acceptedContent<{ confirm: boolean }>(ctx.inputResponses, 'confirm')
    if (!accepted?.confirm) {
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: 'Confirm?',
            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] },
          }),
        },
      })
    }
    return 'done'
  })
}

describe('stateless inputRequired({ inputRequests })', () => {
  it('throws a pointed error naming the switch, distinguishable from the session-state and server-initiated-request guards', async () => {
    const mcp = new FastMCP({ name: 'test', version: '0.0.0' })
    registerAskConfirmation(mcp)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })
    const url = urlFor(mcp)

    await post(url, INITIALIZE)
    const res = await post(url, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'ask', arguments: {} },
    })
    const body = await rpcBody(res)
    expect(body.error).toBeUndefined()
    // The observable shape of a guard thrown from inside a tool handler is a JSON-RPC
    // *result* with isError true, not a top-level JSON-RPC error -- see the `catch` block
    // in FastMCP.ts's tools/call handler, which converts any non-ProtocolError throw into
    // { content, isError: true }. A stub that returned 200 with an empty/ok body, or a
    // guard that silently no-op'd and let the handler re-run to completion, would fail this.
    expect(body.result?.isError).toBe(true)
    const text: string = body.result?.content?.[0]?.text ?? ''
    // 'FASTMCP_STATELESS_HTTP' alone is NOT sufficient: SESSION_STATE_STATELESS_HTTP_ERROR
    // and SERVER_INITIATED_STATELESS_HTTP_ERROR (context.ts) both contain that literal too,
    // so this assertion alone would pass even if the guard threw ctx.elicit's message instead
    // of the inputRequests one -- exactly the distinction this feature turns on. Only
    // INPUT_REQUESTS_STATELESS_HTTP_ERROR (mrtr.ts) names both 'inputRequests' (the thing
    // being rejected) and 'requestState' (the supported alternative); SERVER_INITIATED
    // contains neither, and SESSION_STATE contains 'requestState' but not 'inputRequests'.
    expect(text).toContain('FASTMCP_STATELESS_HTTP')
    expect(text).toContain('inputRequests')
    expect(text).toContain('requestState')
    expect(text).not.toContain('did not declare the required capability')

    await mcp.close()
  })

  // Pins the choice made in mrtr.ts's assertInputRequestsAllowedStateless: a present-but-empty
  // `inputRequests: {}` does NOT count as "has inputRequests" (matching the SDK's own
  // buildInputRequired predicate), so when paired with `requestState` -- which alone already
  // satisfies the SDK's "at least one of the two" requirement -- there is nothing to fulfil and
  // the call must succeed via the requestState mechanism, not be rejected by this guard.
  it('does not reject a degenerate inputRequests: {} paired with requestState -- nothing to fulfil, requestState carries it', async () => {
    const SENTINEL = 'sentinel-degenerate-input-requests'
    const mcp = new FastMCP({ name: 'test', version: '0.0.0', requestState: { key: 'z'.repeat(32) } })
    mcp.tool({ name: 'degenerate', description: 'inputRequired with an empty inputRequests object' }, async () => {
      const ctx = mcp.getContext()
      const state = ctx.requestState<{ done: boolean }>()
      if (!state?.done) {
        return inputRequired({
          inputRequests: {},
          requestState: await ctx.mintRequestState({ done: true }),
        })
      }
      return SENTINEL
    })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })
    const url = urlFor(mcp)

    await post(url, INITIALIZE)
    const res = await post(url, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'degenerate', arguments: {} },
    })
    const body = await rpcBody(res)
    expect(body.error).toBeUndefined()
    expect(body.result?.isError).toBeUndefined()
    expect(body.result?.content?.[0]?.text).toBe(SENTINEL)

    await mcp.close()
  })
})

// `_dispatchTool`/`_dispatchPrompt` (FastMCP.ts) carry no `stateless` flag of their own --
// mounted correctness relies entirely on `_mirrorTool`/`_mirrorPrompt` never wrapping an
// InputRequiredResult in a ToolResult/PromptResult before it reaches the mounting parent's own
// top-level convertResult/convertPromptResult, which is the only place `opts.stateless` (the
// flag that actually matters, belonging to the server serving the wire request) is in scope. See
// the LOAD-BEARING comments at FastMCP.ts's _mirrorTool and _mirrorPrompt. Nothing else in this
// suite drives a tools/call through a mounted child on a stateless server, so nothing else would
// catch a regression here.
describe('stateless mount() with inputRequired', () => {
  it('a mounted child returning inputRequired({ inputRequests }) still throws the pointed error via the parent', async () => {
    const child = new FastMCP({ name: 'child', version: '0.0.0' })
    registerAskConfirmation(child)

    const parent = new FastMCP({ name: 'parent', version: '0.0.0' })
    parent.mount(child, 'kid')
    await parent.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })
    const url = urlFor(parent)

    await post(url, INITIALIZE)
    const res = await post(url, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'kid_ask', arguments: {} },
    })
    const body = await rpcBody(res)
    expect(body.error).toBeUndefined()
    // If _mirrorTool ever wraps an InputRequiredResult in ToolResult (see its LOAD-BEARING
    // comment in FastMCP.ts), the parent's convertResult takes the `instanceof ToolResult`
    // branch instead of recognizing the InputRequiredResult, skips
    // assertInputRequestsAllowedStateless entirely, and this call succeeds with a raw
    // resultType: 'input_required' result instead of throwing -- isError would be undefined
    // and the text assertions below would find nothing.
    expect(body.result?.isError).toBe(true)
    const text: string = body.result?.content?.[0]?.text ?? ''
    expect(text).toContain('FASTMCP_STATELESS_HTTP')
    expect(text).toContain('inputRequests')
    expect(text).toContain('requestState')

    await parent.close()
    await child.close()
  })

  it('a mounted child using the requestState-only pattern still completes its multi-round-trip via the parent', async () => {
    const SENTINEL = 'sentinel-mount-chunked-sum'
    const child = new FastMCP({ name: 'child', version: '0.0.0' })
    registerChunkedSum(child, SENTINEL)

    // `ctx.mintRequestState()` is backed by whichever server actually served the wire request
    // (`this._requestStateCodec` in FastMCP.ts's `_setupHandlers`) -- the mounting parent, not
    // the child -- so `requestState` must be configured here, not on `child`.
    const parent = new FastMCP({ name: 'parent', version: '0.0.0', requestState: { key: 'y'.repeat(32) } })
    parent.mount(child, 'kid')
    await parent.run({ transport: 'http', port: 0, host: '127.0.0.1', stateless: true })
    const url = urlFor(parent)

    await post(url, INITIALIZE)
    const res = await post(url, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      // 7 items, CHUNK 2 -> 4 rounds needed to exhaust the array; see registerChunkedSum.
      params: { name: 'kid_sumChunked', arguments: { items: [1, 2, 3, 4, 5, 6, 7] } },
    })
    const body = await rpcBody(res)
    expect(body.error).toBeUndefined()
    expect(body.result?.isError).toBeUndefined()
    expect(body.result?.content?.[0]?.text).toBe(`${SENTINEL}:28`)

    await parent.close()
    await child.close()
  })
})
