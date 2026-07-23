/**
 * Fixture verifying that auto-detection (no explicit --export) skips past
 * conventional-name exports that aren't themselves a FastMCP instance, rather
 * than committing to the first name match:
 *  - `default` is present but not a FastMCP instance — must be skipped.
 *  - `mcp` is a function — auto-detect must NOT call it (factory resolution
 *    only applies to an explicit --export); calling it would throw and crash
 *    the process, which is how this test detects an incorrect invocation.
 *  - `server` is a real FastMCP instance and should be the one that's used.
 */
import { FastMCP } from '../../src/server/index.js'
import { z } from 'zod'

export default { not: 'a fastmcp instance' }

export function mcp(): never {
  throw new Error('mcp() should not be called during entrypoint auto-detection')
}

export const server = new FastMCP({ name: 'entrypoint-autodetect-skip-fixture', version: '1.0.0' })

server.tool(
  { name: 'echo', description: 'Echo a message back', input: z.object({ message: z.string() }) },
  async ({ message }) => message,
)
