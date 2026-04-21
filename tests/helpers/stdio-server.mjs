/**
 * Minimal MCP server fixture for stdio proxy tests.
 *
 * Plain .mjs (not .ts) so it can be launched directly with `node` from a spawned
 * child process during tests. Vitest compiles TypeScript for test files but does
 * not extend that to arbitrary subprocesses, so a .ts file here would require
 * passing --import tsx or similar to every `node` invocation in the test.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'stdio-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'greet', description: 'greet', inputSchema: { type: 'object', properties: {} } }],
}))

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: 'hello from stdio' }],
}))

await server.connect(new StdioServerTransport())
