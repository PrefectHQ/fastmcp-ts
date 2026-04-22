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

  if (mode.kind === 'stdio') {
    const transport = new StdioTransport(mode.command, mode.args ?? [])
    const client = new Client(transport)
    await client.connect()
    return client
  }

  // in-process: spawn the server file via tsx/node and connect via stdio
  const { spec } = mode
  const [command, cmdArgs] = spec.isTypeScript
    ? ['npx', ['tsx', spec.filePath]]
    : ['node', [spec.filePath]]

  const transport = new StdioTransport(command, cmdArgs, {
    env: { MCP_TRANSPORT: 'stdio' },
  })
  const client = new Client(transport)
  await client.connect()
  return client
}
