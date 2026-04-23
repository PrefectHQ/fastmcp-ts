import { Client } from '../../client/client.js'
import { StdioTransport } from '../../client/transports.js'
import type { CliAuth } from './auth.js'
import type { FileSpec } from './file-spec.js'

export type TransportMode =
  | { kind: 'url'; url: string }
  | { kind: 'stdio'; command: string; args?: string[] }
  | { kind: 'inprocess'; spec: FileSpec }

export async function connectClient(mode: TransportMode, auth?: CliAuth): Promise<Client> {
  if (mode.kind === 'url') {
    const client = new Client(mode.url, { auth })
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
    const client = new Client(transport, { auth })
    await client.connect()
    return client
  }

  // in-process: spawn the server file via tsx/node and connect via stdio
  const { spec } = mode
  const [command, cmdArgs] = spec.isTypeScript
    ? ['npx', ['tsx', spec.filePath]]
    : ['node', [spec.filePath]]

  const transport = new StdioTransport(command, cmdArgs, { env: stdioEnv })
  const client = new Client(transport, { auth })
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
