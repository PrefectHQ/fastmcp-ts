/**
 * Fixture for the double-start guard: exports `server` (so the auto-detect
 * chain finds it) but also self-starts via a top-level `await server.run()`,
 * mimicking a file mid-migration from the legacy self-running style to the
 * entrypoint-export contract. The bootstrap must detect `server.isRunning`
 * and NOT call `.run()` a second time (which would throw for stdio).
 */
import { FastMCP } from '../../src/server/index.js'
import { z } from 'zod'

export const server = new FastMCP({ name: 'entrypoint-already-running-fixture', version: '1.0.0' })

server.tool(
  { name: 'echo', description: 'Echo a message back', input: z.object({ message: z.string() }) },
  async ({ message }) => message,
)

await server.run()
