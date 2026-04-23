/**
 * Fixture FastMCP HTTP server with staticTokenVerifier.
 * Used to verify that --auth is wired through for --url CLI commands.
 *
 * valid-token  → scopes: [read]
 *
 * Logs "listening on http://localhost:PORT/mcp" to stderr once ready so
 * the test harness can read the actual bound port.
 */
import { FastMCP, staticTokenVerifier, requireScopes } from '../../src/server/index.js'
import { z } from 'zod'

const server = new FastMCP({
  name: 'auth-fixture',
  version: '1.0.0',
  auth: staticTokenVerifier({
    'valid-token': { clientId: 'tester', scopes: ['read'] },
  }),
})

server.tool(
  { name: 'public_tool', description: 'No auth required' },
  () => 'public result',
)

server.tool(
  {
    name: 'protected_tool',
    description: 'Requires read scope',
    input: z.object({ msg: z.string() }),
    auth: requireScopes('read'),
  },
  ({ msg }) => `protected: ${msg}`,
)

await server.run({ transport: 'http', port: 0 })
process.stderr.write(`listening on http://localhost:${server.address!.port}/mcp\n`)
