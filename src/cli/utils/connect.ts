import { Client } from '../../client/client.js'
import type { ClientOptions } from '../../client/options.js'
import { StdioTransport } from '../../client/transports.js'
import type { CliAuth } from './auth.js'
import type { FileSpec } from './file-spec.js'
import { resolveEntrypointBootstrapPath, buildEntrypointEnv } from './entrypoint-bootstrap.js'

export type TransportMode =
  | { kind: 'url'; url: string }
  | { kind: 'stdio'; command: string; args?: string[] }
  | { kind: 'inprocess'; spec: FileSpec }

/** CLI-level era selection (`--legacy`, `--pin`; `--modern` is a deprecated
 * no-op); resolved to a concrete `versionNegotiation` mode by
 * `resolveVersionNegotiation`. */
export interface EraOptions {
  /** Deprecated no-op, kept so existing invocations do not break:
   * auto-negotiation is the default on every transport. */
  modern?: boolean
  /** Force the legacy 2025 era: `{ mode: 'legacy' }`, no `server/discover`
   * probe. */
  legacy?: boolean
  pin?: string
}

/**
 * One negotiation default on every transport, decided in one place so every
 * connecting command (list/call/inspect) behaves identically:
 * - The default is `{ mode: 'auto' }`: probe once with `server/discover`, use
 *   the modern (2026-07-28) era when the server offers it, fall back to the
 *   plain legacy handshake otherwise. The SDK keeps the probe stall-safe on
 *   stdio (sibling-process probe, timeout falls back to legacy).
 * - `--legacy` is the opt-out: `{ mode: 'legacy' }` skips the probe entirely.
 * - `--pin` overrides the rest on any transport — it is the strongest
 *   request, so it wins even when `--legacy` (or the deprecated no-op
 *   `--modern`) is also given, mirroring the old pin-beats-modern precedence.
 * Returns an explicit mode in every case rather than `undefined`, so the CLI
 * never leans silently on the library default.
 */
function resolveVersionNegotiation(era?: EraOptions): ClientOptions['versionNegotiation'] {
  if (era?.pin) return { mode: { pin: era.pin } }
  if (era?.legacy) return { mode: 'legacy' }
  return { mode: 'auto' }
}

export async function connectClient(mode: TransportMode, auth?: CliAuth, era?: EraOptions): Promise<Client> {
  const versionNegotiation = resolveVersionNegotiation(era)

  if (mode.kind === 'url') {
    const client = new Client(mode.url, { auth, versionNegotiation })
    await client.connect()
    return client
  }

  // For stdio transports the MCP protocol carries no HTTP headers, so
  // extra.authInfo on the server is always undefined. Inject the bearer
  // token as an environment variable so FastMCP can reconstruct the auth
  // context server-side (see FASTMCP_CLI_AUTH_TOKEN handling in FastMCP.ts).
  const stdioEnv = buildStdioEnv(auth)

  if (mode.kind === 'stdio') {
    const [cmd, ...rest] = mode.command.split(/\s+/)
    const transport = new StdioTransport(cmd!, [...rest, ...(mode.args ?? [])], { env: stdioEnv })
    const client = new Client(transport, { auth, versionNegotiation })
    await client.connect()
    return client
  }

  // in-process: spawn the entrypoint bootstrap via tsx/node and connect via stdio.
  // The bootstrap imports the user's file, resolves the server export, and
  // calls .run() — which honors MCP_TRANSPORT=stdio set in stdioEnv below.
  const { spec } = mode
  const bootstrapPath = resolveEntrypointBootstrapPath()
  const [command, cmdArgs] = spec.isTypeScript
    ? ['npx', ['tsx', bootstrapPath]]
    : ['node', [bootstrapPath]]

  const transport = new StdioTransport(command, cmdArgs, {
    env: { ...stdioEnv, ...buildEntrypointEnv(spec) },
  })
  const client = new Client(transport, { auth, versionNegotiation })
  await client.connect()
  return client
}

function buildStdioEnv(auth: CliAuth | undefined): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, MCP_TRANSPORT: 'stdio' }
  if (auth) {
    const authHeader = auth.getHeaders().Authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
    if (token) env['FASTMCP_CLI_AUTH_TOKEN'] = token
  }
  return env
}
