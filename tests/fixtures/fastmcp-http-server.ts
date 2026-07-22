/**
 * Fixture FastMCP server that explicitly hardcodes transport: 'http'.
 * Used to verify that MCP_TRANSPORT env var overrides the explicit option,
 * which allows `inspect` and `call --file` to force stdio mode.
 *
 * Also used as a dual-era (2025 legacy + 2026-07-28 modern) HTTP fixture:
 * when actually served over HTTP (not overridden to stdio), it logs
 * "listening on http://localhost:PORT/mcp" to stderr once ready so the test
 * harness can read the actual bound port.
 */
import { FastMCP } from '../../src/server/index.js'
import { z } from 'zod'

const server = new FastMCP({ name: 'fastmcp-http-fixture', version: '1.0.0' })

server.tool(
  {
    name: 'echo',
    description: 'Echo a message back',
    input: z.object({ message: z.string() }),
  },
  async ({ message }) => message,
)

// Explicitly hardcodes HTTP — the point is that MCP_TRANSPORT=stdio (set by
// the CLI's inprocess connector) must still win.
await server.run({ transport: 'http', port: 0 })
if (server.address) {
  process.stderr.write(`listening on http://localhost:${server.address.port}/mcp\n`)
}
