import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const server = new Server(
  { name: 'stdio-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler('tools/list', async () => ({
  tools: [{ name: 'greet', description: 'greet', inputSchema: { type: 'object', properties: {} } }],
}))

server.setRequestHandler('tools/call', async () => ({
  content: [{ type: 'text', text: 'hello from stdio' }],
}))

await server.connect(new StdioServerTransport())
