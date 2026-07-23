import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const server = new Server(
  { name: 'env-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler('tools/list', async () => ({
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

server.setRequestHandler('tools/call', async (req) => {
  const varName = String(req.params.arguments?.name ?? '')
  const value = process.env[varName] ?? ''
  return { content: [{ type: 'text', text: value }] }
})

await server.connect(new StdioServerTransport())
