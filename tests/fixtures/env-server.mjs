/**
 * Fixture server that exposes an echo_env tool returning the value of a
 * given environment variable. Used to verify that spawned stdio/in-process
 * servers inherit the parent process environment.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'env-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo_env',
      description: 'Return the value of an environment variable',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Variable name' } },
        required: ['name'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const varName = String(req.params.arguments?.name ?? '')
  const value = process.env[varName] ?? ''
  return { content: [{ type: 'text', text: value }] }
})

await server.connect(new StdioServerTransport())
