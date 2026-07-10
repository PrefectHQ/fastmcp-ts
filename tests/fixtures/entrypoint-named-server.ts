/**
 * Fixture demonstrating the entrypoint-export contract: the file exports a
 * FastMCP instance (named `server`, following the common-name auto-detect
 * convention) and does NOT call `.run()` itself. The CLI's entrypoint
 * bootstrap resolves the export and starts it.
 */
import { FastMCP } from '../../src/server/index.js'
import { z } from 'zod'

export const server = new FastMCP({ name: 'entrypoint-named-fixture', version: '1.0.0' })

server.tool(
  { name: 'echo', description: 'Echo a message back', input: z.object({ message: z.string() }) },
  async ({ message }) => message,
)
