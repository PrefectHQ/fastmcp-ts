import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const server = new Server(
  { name: 'empty-server', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

server.setRequestHandler('tools/list', async () => ({ tools: [] }))
server.setRequestHandler('resources/list', async () => ({ resources: [] }))
server.setRequestHandler('prompts/list', async () => ({ prompts: [] }))

await server.connect(new StdioServerTransport())
