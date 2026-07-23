import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { createServer, type Server as NodeHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { FastMCP, type ServerAddress } from 'fastmcp-ts/server'
import { Client as FastClient } from 'fastmcp-ts/client'
import { stdioPipePair } from '../helpers/stdio.js'

import {
  Client as SdkClient,
  StreamableHTTPClientTransport,
  SdkHttpError,
} from '@modelcontextprotocol/client'
import type { VersionNegotiationOptions } from '@modelcontextprotocol/client'

import { McpServer, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { StdioServerTransport, serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'

// ---------------------------------------------------------------------------
// Interop matrix (W9) — the compatibility contract in executable form.
//
//   A. fastmcp server            × official SDK `Client`   — HTTP, 3 modes
//   B. official servers          × fastmcp `Client`         — HTTP + stdio, 3 modes each
//   C. fastmcp server            × fastmcp `Client`          — HTTP + stdio, both eras
//
// Every row connects over a real transport (ephemeral-port HTTP, or in-process
// stdio pipes wired crosswise — the same no-child-process technique
// tests/helpers/eras.ts uses to exercise the real stdio serving path). No mocks.
//
// One tool ('echo') and one resource (RESOURCE_URI) are registered identically
// on every server so every "connects" cell runs the same two assertions:
// tools/call and resources/read round-trip.
// ---------------------------------------------------------------------------

const TOOL_MESSAGE = 'interop-ping'
const RESOURCE_URI = 'memo://interop-greeting'
const RESOURCE_TEXT = 'hello from the interop matrix'

/** First text content block, or throws — content blocks are `{ type, text? }`. */
function firstToolText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  const block = content.find((b) => b.type === 'text')
  if (block?.text === undefined) throw new Error('expected a text content block')
  return block.text
}

/**
 * First resource-contents text, or throws — resource contents have no `type`
 * discriminator (text vs blob is distinguished by which field is present), so
 * this reads structurally rather than typing the text/blob union precisely.
 */
function firstResourceText(contents: ReadonlyArray<Record<string, unknown>>): string {
  const text = contents[0]?.['text']
  if (typeof text !== 'string') throw new Error('expected text resource contents')
  return text
}

function httpUrl(addr: ServerAddress): URL {
  const host = addr.host === '0.0.0.0' ? '127.0.0.1' : addr.host
  return new URL(`http://${host}:${addr.port}${addr.path}`)
}

// ---------------------------------------------------------------------------
// Server factories — identical tool/resource surface on every side of the matrix.
// ---------------------------------------------------------------------------

/** A dual-era fastmcp server (used on the "fastmcp server" side of A and C). */
function makeFastMcpServer(name: string): FastMCP {
  const mcp = new FastMCP({ name, version: '1.0.0' })
  mcp.tool(
    { name: 'echo', description: 'echoes msg', input: z.object({ msg: z.string() }) },
    ({ msg }) => msg,
  )
  mcp.resource({ uri: RESOURCE_URI, name: 'greeting' }, () => RESOURCE_TEXT)
  return mcp
}

/** A minimal official-SDK server (used on the "official server" side of B). */
function makeOfficialServer(): McpServer {
  const server = new McpServer(
    { name: 'official-interop-server', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  )
  server.registerTool(
    'echo',
    { description: 'echoes msg', inputSchema: z.object({ msg: z.string() }) },
    async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }),
  )
  server.registerResource(
    'greeting',
    RESOURCE_URI,
    { description: 'greeting', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, text: RESOURCE_TEXT, mimeType: 'text/plain' }] }),
  )
  return server
}

// ---------------------------------------------------------------------------
// InteropClient — a normalized facade over the two very different client APIs
// (official SDK `Client` vs fastmcp `Client`) so the cell-spec array below can
// stay one shape regardless of which client a cell exercises.
// ---------------------------------------------------------------------------

interface InteropClient {
  getProtocolEra(): string | undefined
  echo(msg: string): Promise<string>
  readGreeting(): Promise<string>
  /** Closes the client AND, for stdio cells, the per-connection server it booted. */
  close(): Promise<void>
}

function wrapOfficialClient(client: SdkClient): InteropClient {
  return {
    getProtocolEra: () => client.getProtocolEra(),
    echo: async (msg) => {
      const result = await client.callTool({ name: 'echo', arguments: { msg } })
      return firstToolText(result.content as Array<{ type: string; text?: string }>)
    },
    readGreeting: async () => {
      const result = await client.readResource({ uri: RESOURCE_URI })
      return firstResourceText(result.contents as Array<Record<string, unknown>>)
    },
    close: () => client.close(),
  }
}

function wrapFastClient(client: FastClient, extraTeardown?: () => Promise<void>): InteropClient {
  return {
    getProtocolEra: () => client.getProtocolEra(),
    echo: async (msg) => {
      const result = await client.callTool('echo', { msg })
      return firstToolText(result.content as Array<{ type: string; text?: string }>)
    },
    readGreeting: async () => {
      const contents = await client.readResource(RESOURCE_URI)
      return firstResourceText(contents as Array<Record<string, unknown>>)
    },
    close: async () => {
      await client.close()
      await extraTeardown?.()
    },
  }
}

// ---------------------------------------------------------------------------
// Cell spec
// ---------------------------------------------------------------------------

type Outcome = { kind: 'connects'; expectedEra: 'legacy' | 'modern' } | { kind: 'fails' }

interface Cell {
  matrix: 'A' | 'B1-http' | 'B2-stdio' | 'C1-http' | 'C2-stdio'
  label: string
  outcome: Outcome
  connect: () => Promise<InteropClient>
}

// ===========================================================================
// Matrix C — fastmcp × fastmcp (built first: fastest to stand up, both sides
// under our control).
// ===========================================================================

let mcpC1: FastMCP
let baseUrlC1: URL

const cellsC1: Cell[] = (
  [
    { label: 'legacy', versionNegotiation: { mode: 'legacy' }, expectedEra: 'legacy' },
    { label: 'modern (pin)', versionNegotiation: { mode: { pin: '2026-07-28' } }, expectedEra: 'modern' },
  ] as const
).map(({ label, versionNegotiation, expectedEra }) => ({
  matrix: 'C1-http',
  label,
  outcome: { kind: 'connects', expectedEra },
  connect: async () => {
    const client = new FastClient(baseUrlC1.toString(), { versionNegotiation })
    await client.connect()
    return wrapFastClient(client)
  },
}))

const cellsC2: Cell[] = (
  [
    { label: 'legacy', versionNegotiation: { mode: 'legacy' }, expectedEra: 'legacy' },
    { label: 'modern (pin)', versionNegotiation: { mode: { pin: '2026-07-28' } }, expectedEra: 'modern' },
  ] as const
).map(({ label, versionNegotiation, expectedEra }) => ({
  matrix: 'C2-stdio',
  label,
  outcome: { kind: 'connects', expectedEra },
  connect: async () => {
    // Each stdio connection pins one era from its opening exchange, so (unlike the
    // HTTP row above) this cell boots its own fastmcp instance over its own
    // in-process pipe pair — the same crosswise-PassThrough technique
    // tests/helpers/eras.ts uses, real stdio serving with no child process.
    const mcp = makeFastMcpServer('interop-c2-stdio')
    const { clientToServer, serverToClient } = stdioPipePair()
    await mcp.run({ transport: 'stdio', stdin: clientToServer, stdout: serverToClient })
    const client = new FastClient(new StdioServerTransport(serverToClient, clientToServer), {
      versionNegotiation,
    })
    try {
      await client.connect()
    } catch (err) {
      // mcp is already running (mcp.run() above resolved) — a failed client.connect()
      // must not leak it into the rest of the run.
      await mcp.close().catch(() => {})
      throw err
    }
    return wrapFastClient(client, () => mcp.close())
  },
}))

// ===========================================================================
// Matrix A — fastmcp server × official SDK `Client`, over HTTP. One dual-era
// fastmcp server boot serves all three negotiation-mode cells.
// ===========================================================================

let mcpA: FastMCP
let baseUrlA: URL

const cellsA: Cell[] = (
  [
    { label: 'legacy', mode: 'legacy', expectedEra: 'legacy' },
    { label: 'auto', mode: 'auto', expectedEra: 'modern' },
    { label: 'pin 2026-07-28', mode: { pin: '2026-07-28' }, expectedEra: 'modern' },
  ] as const
).map(({ label, mode, expectedEra }) => ({
  matrix: 'A',
  label,
  outcome: { kind: 'connects', expectedEra },
  connect: async () => {
    const versionNegotiation: VersionNegotiationOptions = { mode }
    const client = new SdkClient(
      { name: 'official-interop-client', version: '0.0.0' },
      { capabilities: {}, versionNegotiation },
    )
    await client.connect(new StreamableHTTPClientTransport(baseUrlA))
    return wrapOfficialClient(client)
  },
}))

// ===========================================================================
// Matrix B1 — official `createMcpHandler` (modern-only, `legacy: 'reject'`)
// HTTP server × fastmcp `Client`. One server boot serves all three cells.
// A `legacy`-mode client is expected to fail: no legacy fallback route exists
// on this handler at all (unlike FastMCP's own dual-era router).
// ===========================================================================

let b1HttpServer: NodeHttpServer
let b1Handler: McpHttpHandler
let baseUrlB1: string

const cellsB1: Cell[] = (
  [
    { label: 'legacy', versionNegotiation: { mode: 'legacy' } as const, outcome: { kind: 'fails' } as const },
    {
      label: 'auto',
      versionNegotiation: { mode: 'auto' } as const,
      outcome: { kind: 'connects', expectedEra: 'modern' } as const,
    },
    {
      label: 'pin 2026-07-28',
      versionNegotiation: { mode: { pin: '2026-07-28' } } as const,
      outcome: { kind: 'connects', expectedEra: 'modern' } as const,
    },
  ] as const
).map(({ label, versionNegotiation, outcome }) => ({
  matrix: 'B1-http',
  label,
  outcome,
  connect: async () => {
    const client = new FastClient(baseUrlB1, { versionNegotiation })
    await client.connect()
    return wrapFastClient(client)
  },
}))

// ===========================================================================
// Matrix B2 — official `serveStdio` server (default options — legacy: 'serve')
// × fastmcp `Client`. Unlike B1, this entry has no modern-only restriction, so
// the observed behavior (verified below, not assumed) is that all three modes
// connect: `legacy` pins a 2025-era instance, `auto`/`pin` pin a modern one —
// serveStdio's era decision is made from the opening exchange's shape alone,
// the same dual-era behavior FastMCP's own stdio serving exhibits (see
// tests/helpers/eras.ts). Recorded in the report per the brief.
// ===========================================================================

const cellsB2: Cell[] = (
  [
    { label: 'legacy', versionNegotiation: { mode: 'legacy' }, expectedEra: 'legacy' },
    { label: 'auto', versionNegotiation: { mode: 'auto' }, expectedEra: 'modern' },
    { label: 'pin 2026-07-28', versionNegotiation: { mode: { pin: '2026-07-28' } }, expectedEra: 'modern' },
  ] as const
).map(({ label, versionNegotiation, expectedEra }) => ({
  matrix: 'B2-stdio',
  label,
  outcome: { kind: 'connects', expectedEra },
  connect: async () => {
    // Same one-connection-one-era constraint as C2-stdio: a fresh serveStdio
    // call (and fresh McpServer instance, per its factory contract) per cell.
    const { clientToServer, serverToClient } = stdioPipePair()
    const handle: StdioServerHandle = serveStdio(makeOfficialServer, {
      transport: new StdioServerTransport(clientToServer, serverToClient),
    })
    const client = new FastClient(new StdioServerTransport(serverToClient, clientToServer), {
      versionNegotiation,
    })
    try {
      await client.connect()
    } catch (err) {
      // serveStdio() above is already live — a failed client.connect() must not
      // leak it into the rest of the run.
      await handle.close().catch(() => {})
      throw err
    }
    return wrapFastClient(client, () => handle.close())
  },
}))

describe('Interop matrix (W9)', () => {
  beforeAll(async () => {
    mcpC1 = makeFastMcpServer('interop-c1-http')
    await mcpC1.run({ transport: 'http', port: 0 })
    baseUrlC1 = httpUrl(mcpC1.address!)

    mcpA = makeFastMcpServer('interop-a')
    await mcpA.run({ transport: 'http', port: 0 })
    baseUrlA = httpUrl(mcpA.address!)

    const officialServer = makeOfficialServer()
    b1Handler = createMcpHandler(() => officialServer, { legacy: 'reject' })
    const nodeHandler = toNodeHandler(b1Handler)
    b1HttpServer = createServer((req, res) => {
      void nodeHandler(req, res)
    })
    await new Promise<void>((resolve) => b1HttpServer.listen(0, '127.0.0.1', resolve))
    const port = (b1HttpServer.address() as AddressInfo).port
    baseUrlB1 = `http://127.0.0.1:${port}/mcp`
  })

  afterAll(async () => {
    await mcpC1.close()
    await mcpA.close()
    await b1Handler.close()
    await new Promise<void>((resolve) => b1HttpServer.close(() => resolve()))
  })

  const CELLS: Cell[] = [...cellsA, ...cellsB1, ...cellsB2, ...cellsC1, ...cellsC2]

  it.each(CELLS)(
    '$matrix [$label]: connect, era, tools/call, resources/read',
    async (cell) => {
      if (cell.outcome.kind === 'fails') {
        let error: unknown
        let unexpectedClient: InteropClient | undefined
        try {
          unexpectedClient = await cell.connect()
        } catch (err) {
          error = err
        }
        // A future regression could make this cell connect instead of failing —
        // close the unexpectedly-live client before the assertions below run
        // (which will still fail the test correctly), so it doesn't leak.
        if (unexpectedClient) await unexpectedClient.close().catch(() => {})
        // B1-http/legacy: the modern-only handler (`legacy: 'reject'`) has no
        // legacy fallback route. The opening legacy `initialize` gets HTTP 400
        // with a JSON-RPC -32022 "Unsupported protocol version" body, surfaced
        // client-side as this typed SdkHttpError — not a hang (bounded by the
        // explicit test timeout below).
        expect(error).toBeInstanceOf(SdkHttpError)
        expect((error as SdkHttpError).code).toBe('CLIENT_HTTP_NOT_IMPLEMENTED')
        expect((error as SdkHttpError).data.status).toBe(400)
        return
      }

      const client = await cell.connect()
      try {
        expect(client.getProtocolEra()).toBe(cell.outcome.expectedEra)
        expect(await client.echo(TOOL_MESSAGE)).toBe(TOOL_MESSAGE)
        expect(await client.readGreeting()).toBe(RESOURCE_TEXT)
      } finally {
        await client.close()
      }
    },
    5_000,
  )
})
