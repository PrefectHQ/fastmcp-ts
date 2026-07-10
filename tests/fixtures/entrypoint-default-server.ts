/**
 * Fixture demonstrating auto-detection via a `default` export — the CLI's
 * entrypoint bootstrap tries `default` first when no export name is given.
 */
import { FastMCP } from '../../src/server/index.js'
import { z } from 'zod'

const server = new FastMCP({ name: 'entrypoint-default-fixture', version: '1.0.0' })

server.tool(
  { name: 'echo', description: 'Echo a message back', input: z.object({ message: z.string() }) },
  async ({ message }) => message,
)

export default server
