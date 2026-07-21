import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const server = new Server(
  { name: 'test-server', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo a message back',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    },
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    },
  ],
}))

server.setRequestHandler('tools/call', async (req) => {
  const { name, arguments: args } = req.params
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args?.message ?? '') }] }
  }
  if (name === 'add') {
    const sum = Number(args?.a ?? 0) + Number(args?.b ?? 0)
    return { content: [{ type: 'text', text: JSON.stringify({ sum }) }] }
  }
  throw new Error(`Unknown tool: ${name}`)
})

server.setRequestHandler('resources/list', async () => ({
  resources: [
    { uri: 'memo://greeting', name: 'greeting', description: 'A greeting', mimeType: 'text/plain' },
  ],
}))

server.setRequestHandler('resources/read', async (req) => {
  if (req.params.uri === 'memo://greeting') {
    return { contents: [{ uri: 'memo://greeting', text: 'Hello from resource!', mimeType: 'text/plain' }] }
  }
  throw new Error(`Unknown resource: ${req.params.uri}`)
})

server.setRequestHandler('prompts/list', async () => ({
  prompts: [{ name: 'greet', description: 'A greeting prompt' }],
}))

server.setRequestHandler('prompts/get', async (req) => {
  if (req.params.name === 'greet') {
    return {
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello from prompt!' } }],
    }
  }
  throw new Error(`Unknown prompt: ${req.params.name}`)
})

await server.connect(new StdioServerTransport())
