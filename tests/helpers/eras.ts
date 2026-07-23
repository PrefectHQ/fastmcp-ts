import { describe } from 'vitest'
import {
  Client,
  StreamableHTTPClientTransport,
  LOG_LEVEL_META_KEY,
} from '@modelcontextprotocol/client'
import type { ClientCapabilities } from '@modelcontextprotocol/client'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import type { FastMCP } from 'fastmcp-ts/server'
import { stdioPipePair } from './stdio.js'

// ---------------------------------------------------------------------------
// Dual-era test harness
//
// Connects a raw SDK `Client` (the client the server suites assert against) to a
// FastMCP instance across the four transport/era combos the 1.0 migration serves:
//
//   stdio-legacy            stdio,  2025 era
//   stdio-modern            stdio,  2026-07-28 era
//   http-legacy-sessionful  HTTP,   2025 era (isLegacyRequest → the live sessionful
//                                   NodeStreamableHTTPServerTransport branch — the
//                                   session the elicitation/sampling/state shims need)
//   http-modern             HTTP,   2026-07-28 era (createMcpHandler-backed path)
//
// The era is chosen entirely by the client's `versionNegotiation`; the server's
// hybrid router / serveStdio decide the branch from the wire. Nothing in src is
// changed — the harness only chooses how each suite connects.
// ---------------------------------------------------------------------------

export type EraComboName =
  | 'stdio-legacy'
  | 'stdio-modern'
  | 'http-legacy-sessionful'
  | 'http-modern'

export interface EraCombo {
  readonly name: EraComboName
  readonly era: 'legacy' | 'modern'
  readonly transport: 'stdio' | 'http'
  /**
   * Whether `ctx.setState`/`ctx.getState` survive across requests on this
   * connection. False ONLY for http-modern: a modern HTTP request is dispatched
   * statelessly (createMcpHandler builds a fresh Server with a fresh state Map
   * per request), so a value written in one call is gone by the next. stdio pins
   * one instance — and its state Map — for the connection lifetime, so stdio-modern
   * still persists.
   */
  readonly sessionStatePersists: boolean
}

export const ERA_COMBOS: readonly EraCombo[] = [
  { name: 'stdio-legacy', era: 'legacy', transport: 'stdio', sessionStatePersists: true },
  { name: 'stdio-modern', era: 'modern', transport: 'stdio', sessionStatePersists: true },
  {
    name: 'http-legacy-sessionful',
    era: 'legacy',
    transport: 'http',
    sessionStatePersists: true,
  },
  { name: 'http-modern', era: 'modern', transport: 'http', sessionStatePersists: false },
]

export interface EraConnection {
  client: Client
  combo: EraCombo
  close: () => Promise<void>
}

/**
 * Boots `mcp` on the combo's transport (ephemeral port for HTTP; in-process pipes
 * for stdio) and returns a connected raw SDK `Client` negotiated into the combo's
 * era. Asserts the negotiated era matches — a combo that silently fell back to the
 * wrong era would make every era-fork downstream a lie, so this is the harness's
 * honesty guard.
 */
export async function connectEra(
  mcp: FastMCP,
  combo: EraCombo,
  opts: { capabilities?: ClientCapabilities } = {},
): Promise<EraConnection> {
  const versionNegotiation =
    combo.era === 'modern'
      ? { mode: { pin: '2026-07-28' as const } }
      : { mode: 'legacy' as const }

  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: opts.capabilities ?? {}, versionNegotiation },
  )

  if (combo.transport === 'stdio') {
    // Two PassThrough pipes wired crosswise give an in-process stdio wire. The SDK
    // has no in-process stdio *client* transport (StdioClientTransport only spawns a
    // child), so the client end reuses StdioServerTransport — a symmetric stdio
    // Transport — reading the server's output pipe and writing the server's input
    // pipe. serveStdio negotiates the era from the client's opening exchange over
    // these pipes, exercising the real stdio serving path for BOTH eras with no child
    // process (the server definition lives in the test).
    const { clientToServer, serverToClient } = stdioPipePair()
    await mcp.run({ transport: 'stdio', stdin: clientToServer, stdout: serverToClient })
    await client.connect(new StdioServerTransport(serverToClient, clientToServer))
  } else {
    await mcp.run({ transport: 'http', port: 0 })
    const addr = mcp.address!
    const host = addr.host === '0.0.0.0' ? '127.0.0.1' : addr.host
    const url = new URL(`http://${host}:${addr.port}${addr.path}`)
    await client.connect(new StreamableHTTPClientTransport(url))
  }

  const negotiated = client.getProtocolEra()
  if (negotiated !== combo.era) {
    await client.close().catch(() => {})
    await mcp.close().catch(() => {})
    throw new Error(
      `[eras] combo '${combo.name}' expected to negotiate era '${combo.era}' but got '${negotiated}'`,
    )
  }

  return {
    client,
    combo,
    close: async () => {
      await client.close()
      await mcp.close()
    },
  }
}

/**
 * `describe` a suite body once per era combo. The combo is passed to the body so
 * per-test setup can connect via {@link connectEra} and fork era-gated expectations.
 */
export function describeEachEra(title: string, suite: (combo: EraCombo) => void): void {
  describe.each(ERA_COMBOS as EraCombo[])(`${title} [$name]`, (combo) => {
    suite(combo)
  })
}

/**
 * Merge the per-request log-level `_meta` envelope onto tools/call params for the
 * MODERN era. Modern has no `logging/setLevel` RPC — the desired minimum level is
 * threaded per request through the reserved `io.modelcontextprotocol/logLevel`
 * key, and messages below it (or, absent the key, all of them) are suppressed. On
 * legacy the params are returned unchanged: the default level already forwards
 * everything, and `logging/setLevel` controls filtering out of band.
 */
export function withLogLevel<T extends Record<string, unknown>>(
  combo: EraCombo,
  params: T,
  level: 'debug' | 'info' | 'notice' | 'warning' | 'error' = 'debug',
): T {
  if (combo.era === 'legacy') return params
  const meta = { ...(params._meta as Record<string, unknown> | undefined), [LOG_LEVEL_META_KEY]: level }
  return { ...params, _meta: meta }
}
