import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const server = new Server(
  { name: 'error-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'always-fails',
      description: 'Always throws an error',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

server.setRequestHandler('tools/call', async () => {
  throw new Error('intentional tool error')
})

await server.connect(new StdioServerTransport())
