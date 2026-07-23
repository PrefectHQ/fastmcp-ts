import { describe, it, expect, afterEach } from 'vitest'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Client } from '@modelcontextprotocol/client'
import { FastMCP, inputRequired, acceptedContent } from 'fastmcp-ts/server'

// ---------------------------------------------------------------------------
// Multi Round-Trip Requests (MRTR, protocol revision 2026-07-28)
//
// A single handler, written once with inputRequired(...), must serve both eras
// unchanged: the modern (2026-07-28) wire retries the call directly with
// inputResponses + an echoed requestState, while a legacy (2025-era) connection
// gets the same inputRequired(...) return bridged by the SDK's own legacy shim
// into a real server-initiated elicitation/create request. Both tests below
// register the identical tool handler and assert identical final behavior.
// ---------------------------------------------------------------------------

function registerConfirmingTool(mcp: FastMCP): void {
  mcp.tool(
    { name: 'deleteFiles', description: 'Delete files, asking for confirmation first' },
    async (args: Record<string, unknown>) => {
      const count = args.count as number
      const ctx = mcp.getContext()
      const accepted = acceptedContent<{ confirm: boolean }>(ctx.inputResponses, 'confirm')
      if (!accepted?.confirm) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Delete ${count} files?`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean' } },
                required: ['confirm'],
              },
            }),
          },
        })
      }
      return `Deleted ${count} files`
    },
  )
}

describe('Server — Multi Round-Trip Requests (MRTR)', () => {
  let close: () => Promise<void>

  afterEach(async () => {
    await close?.()
  })

  it('a tool using inputRequired completes a full multi-round-trip on the modern (2026-07-28) wire', async () => {
    const mcp = new FastMCP({ name: 'mrtr-test' })
    registerConfirmingTool(mcp)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    close = () => mcp.close()

    const url = `http://127.0.0.1:${mcp.address!.port}/mcp`
    // The client must declare the elicitation capability in its per-request envelope —
    // the same MissingRequiredClientCapability gate (-32021) that guards the legacy
    // push-style request applies to the embedded MRTR request.
    const envelopeMeta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
    }
    const headers = {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'deleteFiles',
    }

    // Round 1: the server can't answer synchronously — it returns input_required.
    const res1 = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'deleteFiles', arguments: { count: 3 }, _meta: envelopeMeta },
      }),
    })
    const body1 = await res1.json()
    expect(body1.result.resultType).toBe('input_required')
    expect(body1.result.inputRequests.confirm.method).toBe('elicitation/create')
    // This handler only returns inputRequests (no requestState) — a single-round flow
    // whose retry re-sends the same tool arguments needs no server-minted state to
    // thread through. requestState is exercised by FastMCPOptions.requestState /
    // ctx.mintRequestState() for multi-round flows (see the dedicated test below).

    // Round 2: retry the same call, answering the embedded request.
    const res2 = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'deleteFiles',
          arguments: { count: 3 },
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          _meta: envelopeMeta,
        },
      }),
    })
    const body2 = await res2.json()
    expect(body2.result.content).toEqual([{ type: 'text', text: 'Deleted 3 files' }])
  })

  it('the identical inputRequired handler works unchanged on a legacy (2025-era) connection via the SDK legacy shim', async () => {
    const mcp = new FastMCP({ name: 'mrtr-test' })
    registerConfirmingTool(mcp)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    close = () => mcp.close()

    // A plain, default (legacy-era) client — no versionNegotiation opt-in — with an
    // elicitation handler registered the ordinary 2025 way. The server's identical
    // inputRequired(...) return is bridged by the SDK's legacy shim into a real
    // server-initiated elicitation/create request over this sessionful connection.
    const client = new Client(
      { name: 'legacy-client', version: '0.0.0' },
      { capabilities: { elicitation: {} } },
    )
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }))
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address!.port}/mcp`)),
    )

    const result = await client.callTool({ name: 'deleteFiles', arguments: { count: 3 } })
    expect(result.content).toEqual([{ type: 'text', text: 'Deleted 3 files' }])

    await client.close()
  })
})

describe('Server — requestState (FastMCPOptions.requestState / ctx.mintRequestState / ctx.requestState)', () => {
  let close: () => Promise<void>

  afterEach(async () => {
    await close?.()
  })

  function registerStatefulTool(mcp: FastMCP): void {
    mcp.tool(
      { name: 'deleteFilesStateful', description: 'Delete files, threading server-minted state across the round-trip' },
      async (args: Record<string, unknown>) => {
        const count = args.count as number
        const ctx = mcp.getContext()
        const accepted = acceptedContent<{ confirm: boolean }>(ctx.inputResponses, 'confirm')
        if (!accepted?.confirm) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Delete ${count} files?`,
                requestedSchema: {
                  type: 'object',
                  properties: { confirm: { type: 'boolean' } },
                  required: ['confirm'],
                },
              }),
            },
            requestState: await ctx.mintRequestState({ count, mintedBy: 'deleteFilesStateful' }),
          })
        }
        const state = ctx.requestState<{ count: number; mintedBy: string }>()
        return `Deleted ${state?.count} files (state.mintedBy=${state?.mintedBy})`
      },
    )
  }

  const envelopeMeta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
  }
  const headers = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/call',
    'Mcp-Name': 'deleteFilesStateful',
  }

  it('mints a signed requestState and hands the handler the verified, decoded payload on retry', async () => {
    const mcp = new FastMCP({ name: 'requeststate-test', requestState: { key: 'a'.repeat(32) } })
    registerStatefulTool(mcp)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    close = () => mcp.close()

    const url = `http://127.0.0.1:${mcp.address!.port}/mcp`

    const res1 = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'deleteFilesStateful', arguments: { count: 5 }, _meta: envelopeMeta },
      }),
    })
    const body1 = await res1.json()
    expect(body1.result.resultType).toBe('input_required')
    const requestState = body1.result.requestState
    expect(requestState).toBeTypeOf('string')

    const res2 = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'deleteFilesStateful',
          arguments: { count: 5 },
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          requestState,
          _meta: envelopeMeta,
        },
      }),
    })
    const body2 = await res2.json()
    expect(body2.result.content).toEqual([
      { type: 'text', text: 'Deleted 5 files (state.mintedBy=deleteFilesStateful)' },
    ])
  })

  it('rejects a tampered requestState with the frozen -32602 error, never reaching the handler', async () => {
    const mcp = new FastMCP({ name: 'requeststate-test', requestState: { key: 'a'.repeat(32) } })
    registerStatefulTool(mcp)
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    close = () => mcp.close()

    const url = `http://127.0.0.1:${mcp.address!.port}/mcp`

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'deleteFilesStateful',
          arguments: { count: 5 },
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          requestState: 'v1.dGFtcGVyZWQ.dGFtcGVyZWQ',
          _meta: envelopeMeta,
        },
      }),
    })
    const body = await res.json()
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toBe('Invalid or expired requestState')
  })
})
