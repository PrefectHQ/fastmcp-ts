/**
 * Fixture FastMCP server that explicitly hardcodes transport: 'http'.
 * Used to verify that MCP_TRANSPORT env var overrides the explicit option,
 * which allows `inspect` and `call --file` to force stdio mode.
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
server.run({ transport: 'http', port: 0 })
