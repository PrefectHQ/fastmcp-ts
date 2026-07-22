import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FastMCP, inputRequired, acceptedContent } from 'fastmcp-ts/server'
import type { ServerAddress } from 'fastmcp-ts/server'

// ===========================================================================
// Wire-level golden tests (W9) — raw-HTTP JSON-RPC transcripts that pin the
// 2026-07-28 (modern-era) wire behavior byte-for-byte.
//
// These speak RAW `fetch` with hand-built JSON-RPC bodies and headers against a
// booted FastMCP on an ephemeral port. NO MCP client library on the test side —
// that is the point: the client SDK could paper over a server-side wire
// regression, so the assertions here reconstruct the bytes by hand and compare
// them to inline expected structures.
//
// GOLDEN STYLE: inline expected JSON structures (not committed .json fixtures).
// The pinned surfaces are small and targeted (one method's result members, one
// error's code+message+data), so an inline literal beside each assertion yields
// the clearest regression diff. The single volatile member — the opaque,
// HMAC+expiry `requestState` token — is normalized by `scrubRequestState` before
// a whole-object compare (ids and ports never reach the compared bodies: ids are
// fixed per request and asserted directly where they carry contract meaning; the
// port lives only in the URL).
//
// Every non-obvious expected byte cites its source in a comment: an
// `@modelcontextprotocol/server@2.0.0-beta.5` .d.mts docstring / schema, or a
// spec / SEP section name. Byte captures were reconciled against the real server
// (see the RED→GREEN note in .tmp/sdd/task-7-report.md).
// ===========================================================================

// --- Reserved `_meta` envelope keys (protocol revision 2026-07-28) ----------
// Inlined as literals (not imported) so the golden pins the exact wire key; a
// regression that renamed the SDK constant must not silently move the golden
// with it. Values verified against @modelcontextprotocol/core/internal:
//   PROTOCOL_VERSION_META_KEY     = "io.modelcontextprotocol/protocolVersion"
//   CLIENT_CAPABILITIES_META_KEY  = "io.modelcontextprotocol/clientCapabilities"
//   SERVER_INFO_META_KEY          = "io.modelcontextprotocol/serverInfo"
//   SUBSCRIPTION_ID_META_KEY      = "io.modelcontextprotocol/subscriptionId"
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities'
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo'
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId'

// The modern wire revision. MODERN_WIRE_REVISION literal in
// core-internal/src/wire/codec.ts (SDK src). Deliberately not a public constant.
const MODERN = '2026-07-28'

// -32020 HeaderMismatch: the SEP-2243 `HEADER_MISMATCH` code. It has NO
// ProtocolErrorCode enum member — "not part of the 2025-era wire vocabulary; the
// validation ladder is its only emitter" (src inboundClassification.ts:
// HEADER_MISMATCH_ERROR_CODE = -32020). The ladder maps it to HTTP 400
// (LADDER_ERROR_HTTP_STATUS).
const HEADER_MISMATCH = -32020
// -32602 InvalidParams (ProtocolErrorCode.InvalidParams). The 2026-07-28 code for
// a `resources/read` miss (spec MUST) and for envelope-rung rejections.
const INVALID_PARAMS = -32602

// ---------------------------------------------------------------------------
// Raw-fetch helpers
// ---------------------------------------------------------------------------

function baseUrl(addr: ServerAddress): string {
  const host = addr.host === '0.0.0.0' ? '127.0.0.1' : addr.host
  return `http://${host}:${addr.port}${addr.path}`
}

/**
 * A per-request modern `_meta` envelope. The two members below are REQUIRED by
 * `RequestMetaEnvelopeSchema` (2026-era codec): `protocolVersion` is a bare
 * `z.string()`, `clientCapabilities` is a bare `ClientCapabilities2026Schema`
 * (neither `.optional()`). Requiredness is enforced per request at dispatch time
 * by the codec's `checkInboundEnvelope` step.
 */
function envelope(caps: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_CAPABILITIES_META_KEY]: caps,
  }
}

interface RpcOutcome {
  status: number
  contentType: string
  json: {
    jsonrpc?: string
    id?: unknown
    result?: Record<string, unknown>
    error?: { code: number; message: string; data?: unknown }
  }
}

/**
 * POST one JSON-RPC message and read the response as a single JSON body (the
 * modern handler answers a lone request with `Content-Type: application/json`).
 * `Accept` always offers both media types — the same pair the real Streamable
 * HTTP client sends — so the server may legally choose either framing.
 */
async function rpc(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<RpcOutcome> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const contentType = res.headers.get('content-type') ?? ''
  const text = await res.text()
  const json = contentType.includes('text/event-stream') ? parseLastSseData(text) : JSON.parse(text)
  return { status: res.status, contentType, json }
}

/** Extract the JSON payload of the last `data:` line of an SSE body. */
function parseLastSseData(text: string): RpcOutcome['json'] {
  const dataLines = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice('data:'.length).trim())
  return JSON.parse(dataLines[dataLines.length - 1])
}

/**
 * The only volatile member in any pinned body: the opaque `requestState` token
 * (HMAC signature + embedded `exp` timestamp — changes every run). Replaced with
 * a stable placeholder so the surrounding result shape can be compared whole. The
 * scrubber is deliberately narrow (one named key) so it never masks a real
 * regression elsewhere in the object.
 */
function scrubRequestState(result: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = structuredClone(result)
  if (typeof clone.requestState === 'string') clone.requestState = '<requestState>'
  return clone
}

const SERVER_INFO = { name: 'wire-golden', version: '1.0.0' }
/** The result `_meta` every modern result carries: the server stamps its
 * Implementation under `io.modelcontextprotocol/serverInfo` (spec PR #3002:
 * `DiscoverResult.serverInfo` moved to the `ResultMetaObject` key; the SDK's
 * `stampServerInfoMeta` encode step stamps it on every result's `_meta`). */
const RESULT_META = { [SERVER_INFO_META_KEY]: SERVER_INFO }

// ===========================================================================
// 1. server/discover — the modern discovery document's required members.
// ===========================================================================
describe('wire golden — server/discover response shape', () => {
  let mcp: FastMCP
  let url: string
  beforeAll(async () => {
    mcp = new FastMCP({ ...SERVER_INFO })
    mcp.tool({ name: 'echo', description: 'echoes', input: z.object({ msg: z.string() }) }, ({ msg }) => msg)
    mcp.resource({ uri: 'memo://g', name: 'g', mimeType: 'text/plain' }, () => 'hi')
    mcp.prompt({ name: 'p', description: 'p' }, () => 'hi')
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    url = baseUrl(mcp.address!)
  })
  afterAll(() => mcp.close())

  it('pins the DiscoverResult members (supportedVersions, capabilities, cache fields, resultType, serverInfo)', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope() } },
      // server/discover is modern-classified, so the standard-header rung requires
      // the Mcp-Method header (SEP-2243). No Mcp-Name source for this method.
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'server/discover' },
    )
    expect(out.status).toBe(200)

    // DiscoverResultSchema$1 (2026-era codec): wireResult({ ttlMs, cacheScope,
    // supportedVersions: string[], capabilities: ServerCapabilities2026Schema,
    // instructions?: string }). `resultType` is added by `wireResult` (default
    // "complete"); ttlMs/cacheScope are the SEP-2549 CacheableResult fields.
    // `instructions` is optional (FastMCP declares none) so it is absent here.
    expect(out.json.result).toEqual({
      supportedVersions: [MODERN],
      capabilities: {
        // FastMCP advertises listChanged on all three registries + logging.
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
        logging: {},
      },
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      _meta: RESULT_META,
    })
  })

  it('fixes the exact top-level key set of the discovery document', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'server/discover' },
    )
    // Assert the exact key set (spec fixes these members) — not merely "has property".
    expect(Object.keys(out.json.result!).sort()).toEqual(
      ['_meta', 'cacheScope', 'capabilities', 'resultType', 'supportedVersions', 'ttlMs'].sort(),
    )
  })
})

// ===========================================================================
// 2. Per-request `_meta` envelope — parse/echo + required members.
// ===========================================================================
describe('wire golden — per-request _meta envelope', () => {
  let mcp: FastMCP
  let url: string
  beforeAll(async () => {
    mcp = new FastMCP({ ...SERVER_INFO })
    mcp.tool({ name: 'echo', description: 'echoes', input: z.object({ msg: z.string() }) }, ({ msg }) => msg)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    url = baseUrl(mcp.address!)
  })
  afterAll(() => mcp.close())

  it('parses a valid envelope and echoes serverInfo in the result _meta', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: envelope(), name: 'echo', arguments: { msg: 'hi' } } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    )
    expect(out.status).toBe(200)
    // Server's echo behaviour: it stamps its own Implementation into the result's
    // `_meta` under the reserved serverInfo key (stampServerInfoMeta encode step).
    expect(out.json.result!._meta).toEqual(RESULT_META)
  })

  it('rejects an envelope missing the required clientCapabilities member with -32602', async () => {
    // clientCapabilities is a REQUIRED member of RequestMetaEnvelopeSchema (bare
    // ClientCapabilities2026Schema, not .optional()). checkInboundEnvelope runs the
    // schema and, on failure, the `envelope` ladder rung answers -32602 on HTTP 400
    // ("the only place an invalid-params rejection maps to HTTP 400").
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN }, name: 'echo', arguments: { msg: 'hi' } } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    )
    expect(out.status).toBe(400)
    expect(out.json.error).toEqual({
      code: INVALID_PARAMS,
      message:
        'Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/clientCapabilities: missing',
      data: { envelope: { key: 'io.modelcontextprotocol/clientCapabilities', problem: 'missing' } },
    })
  })

  it('rejects a request whose header names modern but whose body carries no envelope claim with -32602', async () => {
    // Body-primary classification: a body without the protocol-version _meta key
    // makes NO envelope claim. When the MCP-Protocol-Version header nonetheless
    // names a modern revision, the envelope rung answers -32602 naming the missing
    // key (never a silent fall back to legacy). Here `_meta` is absent entirely.
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    )
    expect(out.status).toBe(400)
    expect(out.json.error).toEqual({
      code: INVALID_PARAMS,
      message:
        'Invalid params: the MCP-Protocol-Version header names protocol revision 2026-07-28, but the request is missing the required per-request envelope key(s): _meta',
      data: { envelope: { missing: ['_meta'] } },
    })
  })
})

// ===========================================================================
// 3. resultType handling on tools/call.
// ===========================================================================
describe('wire golden — resultType on tools/call', () => {
  let mcp: FastMCP
  let url: string
  beforeAll(async () => {
    mcp = new FastMCP({ ...SERVER_INFO })
    mcp.tool({ name: 'echo', description: 'echoes', input: z.object({ msg: z.string() }) }, ({ msg }) => msg)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    url = baseUrl(mcp.address!)
  })
  afterAll(() => mcp.close())

  it('a complete tools/call result carries resultType:"complete" on the wire', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: envelope(), name: 'echo', arguments: { msg: 'hello' } } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    )
    expect(out.status).toBe(200)
    // `resultType` is the wire discriminator every modern result carries: the codec
    // `stampResultType` encode step adds it, default "complete". CallToolResult
    // (2026-era) = wireResult({ content, structuredContent?, isError? }).
    expect(out.json.result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      resultType: 'complete',
      _meta: RESULT_META,
    })
  })
})

// ===========================================================================
// 4. inputRequired round-trip incl. byte-exact requestState echo.
// ===========================================================================
describe('wire golden — inputRequired round-trip + byte-exact requestState echo', () => {
  let mcp: FastMCP
  let url: string
  // Payload minted into requestState on round 1 and recovered (decoded) on round 2.
  const PAYLOAD = { label: 'delete', nonce: 'abc123' }

  beforeAll(async () => {
    mcp = new FastMCP({
      ...SERVER_INFO,
      // HMAC-SHA256 integrity protection for requestState (spec basic/patterns/mrtr
      // §Server Requirements: state that influences business logic MUST be protected
      // and verification failures MUST be rejected). Backed by createRequestStateCodec.
      // Key MUST be >= 32 bytes.
      requestState: { key: 'wire-golden-requestState-hmac-secret-0123456789' },
    })
    mcp.tool(
      { name: 'confirm', description: 'needs confirmation', input: z.object({ label: z.string() }) },
      async ({ label }) => {
        const ctx = mcp.getContext()
        // acceptedContent surfaces the client's accepted elicitation content, or
        // undefined on the flow's first call (no prior round).
        const confirmed = acceptedContent<{ ok: boolean }>(ctx.inputResponses, 'confirm')
        if (confirmed === undefined) {
          // Round 1 — request input; mint opaque state to carry across the round trip.
          const rs = await ctx.mintRequestState({ label, nonce: 'abc123' })
          return inputRequired({
            inputRequests: {
              confirm: {
                method: 'elicitation/create',
                params: {
                  message: `Confirm ${label}?`,
                  requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
                },
              },
            },
            requestState: rs,
          })
        }
        // Round 2 — the seam already verified+decoded the echoed requestState (or
        // rejected it). ctx.requestState() returns the decoded payload.
        const state = ctx.requestState<typeof PAYLOAD>()
        return `confirmed:${JSON.stringify(state)}`
      },
    )
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    url = baseUrl(mcp.address!)
  })
  afterAll(() => mcp.close())

  // The confirm tool needs the elicitation.form capability declared in the
  // envelope, else the input-required capability gate answers -32021 pre-dispatch.
  const caps = { elicitation: { form: {} } }

  it('round 1 returns resultType:"input_required" with the embedded inputRequests and a signed requestState', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: envelope(caps), name: 'confirm', arguments: { label: 'delete' } } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'confirm' },
    )
    expect(out.status).toBe(200)

    // InputRequiredResult (SDK): { resultType:'input_required', inputRequests?,
    // requestState? } — "the one place the wire discriminator resultType appears on
    // the neutral surface". Whole-result compare with the volatile token scrubbed.
    expect(scrubRequestState(out.json.result!)).toEqual({
      resultType: 'input_required',
      inputRequests: {
        confirm: {
          method: 'elicitation/create',
          params: {
            message: 'Confirm delete?',
            requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          },
        },
      },
      requestState: '<requestState>',
      _meta: RESULT_META,
    })
    // The real token is an opaque, HMAC-signed string (createRequestStateCodec's
    // "v1.<payload>.<mac>" framing). Pinned structurally — its exact bytes carry a
    // per-run expiry and cannot be a fixed golden.
    expect(typeof out.json.result!.requestState).toBe('string')
    expect(out.json.result!.requestState as string).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  it('round 2 echoes the requestState byte-exact; the server verifies it and the flow completes', async () => {
    // --- Round 1: mint + capture the token ---
    const r1 = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: envelope(caps), name: 'confirm', arguments: { label: 'delete' } } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'confirm' },
    )
    const mintedRequestState = r1.json.result!.requestState as string

    // --- Round 2: echo the token VERBATIM alongside the corrective response ---
    // Byte-exact echo, compared as a serialized string (`toBe`), never
    // parsed-and-deep-equal: the HMAC covers the exact bytes, so the retry MUST
    // carry the mint unchanged. (The tamper case below proves a single altered byte
    // is rejected — i.e. that this exactness is enforced, not incidental.)
    const round2Params = {
      _meta: envelope(caps),
      name: 'confirm',
      arguments: { label: 'delete' },
      // Retry channel (retryParamsShape): inputResponses + requestState are
      // top-level tools/call params on the 2026-07-28 revision.
      inputResponses: { confirm: { action: 'accept', content: { ok: true } } },
      requestState: mintedRequestState,
    }
    // Meaningful check (not a self-comparison): the value actually placed in the
    // round-2 request body is the token round 1 minted, byte-for-byte. Guards the
    // request construction — a refactor that echoed a different token fails here.
    expect(round2Params.requestState).toBe(mintedRequestState)

    const r2 = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: round2Params },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'confirm' },
    )
    expect(r2.status).toBe(200)
    // Proof the exact bytes verified and decoded losslessly: the handler recovered
    // the minted payload and serialized it back. Compared as the serialized string.
    expect(r2.json.result).toEqual({
      content: [{ type: 'text', text: `confirmed:${JSON.stringify(PAYLOAD)}` }],
      resultType: 'complete',
      _meta: RESULT_META,
    })
  })

  it('a tampered requestState (one byte appended) fails verification with -32602', async () => {
    const r1 = await rpc(
      url,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { _meta: envelope(caps), name: 'confirm', arguments: { label: 'delete' } } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'confirm' },
    )
    const tampered = (r1.json.result!.requestState as string) + 'X'

    const r2 = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          _meta: envelope(caps),
          name: 'confirm',
          arguments: { label: 'delete' },
          inputResponses: { confirm: { action: 'accept', content: { ok: true } } },
          requestState: tampered,
        },
      },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'confirm' },
    )
    // The seam rejects state the verify hook refuses. The wire shape is FROZEN by
    // the SDK (ServerOptions.requestState.verify doc): a -32602 whose message is
    // frozen to "Invalid or expired requestState" and whose data.reason is
    // 'invalid_request_state'. In-band error → HTTP 200.
    expect(r2.status).toBe(200)
    expect(r2.json.error).toEqual({
      code: INVALID_PARAMS,
      message: 'Invalid or expired requestState',
      data: { reason: 'invalid_request_state' },
    })
  })
})

// ===========================================================================
// 5. subscriptions/listen open/close lifecycle over HTTP.
// ===========================================================================
describe('wire golden — subscriptions/listen open/close lifecycle', () => {
  let mcp: FastMCP
  let url: string
  beforeAll(async () => {
    mcp = new FastMCP({ ...SERVER_INFO })
    mcp.tool({ name: 'echo', description: 'echoes', input: z.object({ msg: z.string() }) }, ({ msg }) => msg)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    url = baseUrl(mcp.address!)
  })
  afterAll(() => mcp.close())

  it('OPEN: a listen request returns a text/event-stream primed with notifications/subscriptions/acknowledged', async () => {
    const controller = new AbortController()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MODERN,
        'Mcp-Method': 'subscriptions/listen',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'subscriptions/listen',
        // SubscriptionsListenRequest params: { notifications: SubscriptionFilter }.
        params: { _meta: envelope(), notifications: { toolsListChanged: true } },
      }),
      signal: controller.signal,
    })
    try {
      // The subscription stream is a long-lived SSE channel, not a lone JSON reply.
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      // Read exactly the priming event, then stop. The stream stays open otherwise.
      const reader = res.body!.getReader()
      const { value } = await reader.read()
      const chunk = new TextDecoder().decode(value)
      const primed = parseLastSseData(chunk)

      // SubscriptionsAcknowledgedNotification (2026-only): the server acknowledges
      // the opened subscription, echoing the filter and stamping the demux id under
      // the reserved subscriptionId _meta key (SubscriptionsListenResultMeta's
      // required stamp). The id equals the listen request's id (7).
      expect(primed).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: {
          notifications: { toolsListChanged: true },
          _meta: { [SUBSCRIPTION_ID_META_KEY]: 7 },
        },
      })
    } finally {
      // CLOSE: aborting the fetch tears the SSE channel down (an abrupt transport
      // close carries no response — the client treats stream-close as the end of
      // the subscription; SubscriptionsListenResultSchema doc).
      controller.abort()
    }
  })

  it('CLOSE: after the stream is torn down the server stays responsive to a fresh request', async () => {
    const controller = new AbortController()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MODERN,
        'Mcp-Method': 'subscriptions/listen',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'subscriptions/listen',
        params: { _meta: envelope(), notifications: { toolsListChanged: true } },
      }),
      signal: controller.signal,
    })
    await res.body!.getReader().read() // drain the priming event
    controller.abort() // client-initiated close

    // A follow-up unary request still round-trips — the closed subscription did not
    // wedge the endpoint.
    const after = await rpc(
      url,
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { _meta: envelope(), name: 'echo', arguments: { msg: 'alive' } } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    )
    expect(after.status).toBe(200)
    expect(after.json.result!.content).toEqual([{ type: 'text', text: 'alive' }])
  })
})

// ===========================================================================
// 6. Required headers + -32020 mismatch rejection.
// ===========================================================================
describe('wire golden — required headers and -32020 mismatch rejection', () => {
  let mcp: FastMCP
  let url: string
  beforeAll(async () => {
    mcp = new FastMCP({ ...SERVER_INFO })
    mcp.tool({ name: 'echo', description: 'echoes', input: z.object({ msg: z.string() }) }, ({ msg }) => msg)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    url = baseUrl(mcp.address!)
  })
  afterAll(() => mcp.close())

  it('MCP-Protocol-Version header disagreeing with the body envelope → HTTP 400 / -32020', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: envelope(), name: 'echo', arguments: { msg: 'x' } } },
      // Body envelope claims 2026-07-28; header names the legacy 2025-11-25 → the
      // era-classification rung's header/body cross-check disagreement.
      { 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    )
    // Assert BOTH the HTTP status AND the JSON-RPC code (crossCheckMismatch shape).
    expect(out.status).toBe(400)
    expect(out.json.error).toEqual({
      code: HEADER_MISMATCH,
      message:
        'Bad Request: the request headers and body disagree: the body envelope names protocol version 2026-07-28 but the MCP-Protocol-Version header names 2025-11-25',
      data: {
        mismatch: {
          header: '2025-11-25',
          body: 'the body envelope names protocol version 2026-07-28 but the MCP-Protocol-Version header names 2025-11-25',
        },
      },
    })
  })

  it('the required Mcp-Method header being absent on a modern request → HTTP 400 / -32020', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: envelope(), name: 'echo', arguments: { msg: 'x' } } },
      // Modern-classified via the body envelope, but the SEP-2243 standard-header
      // rung requires Mcp-Method present (validateStandardRequestHeaders).
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Name': 'echo' },
    )
    expect(out.status).toBe(400)
    expect(out.json.error).toEqual({
      code: HEADER_MISMATCH,
      message:
        'Bad Request: the request headers and body disagree: the body names method tools/call but the required Mcp-Method header is absent',
      data: {
        mismatch: {
          header: '(missing)',
          body: 'the body names method tools/call but the required Mcp-Method header is absent',
        },
      },
    })
  })
})

// ===========================================================================
// 7. ttlMs / cacheScope presence where the server declares cache hints.
// ===========================================================================
describe('wire golden — ttlMs / cacheScope cache-hint presence', () => {
  let mcp: FastMCP
  let url: string
  beforeAll(async () => {
    mcp = new FastMCP({
      ...SERVER_INFO,
      // Declared cache hint for resources/read (SEP-2549). resources/list gets no
      // hint, so it keeps the conservative defaults — the two are contrasted below.
      cacheHints: { 'resources/read': { ttlMs: 5000, cacheScope: 'public' } },
    })
    mcp.resource({ uri: 'memo://g', name: 'g', mimeType: 'text/plain' }, () => 'hi there')
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    url = baseUrl(mcp.address!)
  })
  afterAll(() => mcp.close())

  it('resources/read carries the DECLARED ttlMs / cacheScope hint on the wire', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { _meta: envelope(), uri: 'memo://g' } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'resources/read', 'Mcp-Name': 'memo://g' },
    )
    expect(out.status).toBe(200)
    // ReadResourceResult (2026-era) = wireResult({ ttlMs: int>=0, cacheScope:
    // 'public'|'private', contents }) — ttlMs/cacheScope REQUIRED per the anchor.
    // The configured hint (5000 / 'public') is stamped by the fillCacheFields step.
    expect(out.json.result).toEqual({
      contents: [{ uri: 'memo://g', mimeType: 'text/plain', text: 'hi there' }],
      resultType: 'complete',
      ttlMs: 5000,
      cacheScope: 'public',
      _meta: RESULT_META,
    })
  })

  it('resources/list without a declared hint keeps the conservative defaults (ttlMs:0, cacheScope:private)', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'resources/list', params: { _meta: envelope() } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'resources/list' },
    )
    expect(out.status).toBe(200)
    // CacheHint doc: absent fields fall back to the conservative defaults
    // (ttlMs: 0, cacheScope: 'private'). ListResourcesResult REQUIRES both fields.
    expect(out.json.result!.ttlMs).toBe(0)
    expect(out.json.result!.cacheScope).toBe('private')
  })
})

// ===========================================================================
// 8. Unknown resource resources/read → -32602 (NOT -32002).
// ===========================================================================
describe('wire golden — unknown resources/read → -32602', () => {
  let mcp: FastMCP
  let url: string
  beforeAll(async () => {
    mcp = new FastMCP({ ...SERVER_INFO })
    mcp.resource({ uri: 'memo://known', name: 'known', mimeType: 'text/plain' }, () => 'hi')
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    url = baseUrl(mcp.address!)
  })
  afterAll(() => mcp.close())

  it('a resources/read miss answers -32602 Invalid Params, never -32002', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { _meta: envelope(), uri: 'memo://missing' } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'resources/read', 'Mcp-Name': 'memo://missing' },
    )
    // Spec 2026-07-28 MUST: "resources/read misses answer -32602 (Invalid Params)
    // on every protocol revision ... a handler-thrown -32002 is mapped to -32602 at
    // the era encode seam" (ProtocolErrorCode.ResourceNotFound doc; encodeErrorCode:
    // code === -32002 ? -32602). In-band error → HTTP 200.
    expect(out.status).toBe(200)
    expect(out.json.error!.code).toBe(INVALID_PARAMS)
    expect(out.json.error!.code).not.toBe(-32002)
    expect(out.json.error!.message).toBe('Unknown resource: "memo://missing"')
  })

  // RESOLVED (task-9): the miss now throws the SDK's `ResourceNotFoundError`
  // (FastMCP.ts resources/read + _dispatchResource), which stamps `data: { uri }`
  // (exactly one key) and keeps the `-32602` code. The SDK recognition contract
  // (ResourceNotFoundError doc) is: "a -32602 whose data carries uri and nothing else
  // is resource-not-found; any other -32602 is an ordinary Invalid Params" — a client
  // built on that contract can now distinguish this miss. This test pins the
  // spec-correct shape as a normal assertion (the task-7 `.fails` marker is off).
  it('echoes the requested uri in error.data so clients recognise resource-not-found', async () => {
    const out = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { _meta: envelope(), uri: 'memo://missing' } },
      { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'resources/read', 'Mcp-Name': 'memo://missing' },
    )
    // Spec-correct recognition contract: error.data is exactly { uri: <requested> }.
    expect(out.json.error!.data).toEqual({ uri: 'memo://missing' })
  })
})
