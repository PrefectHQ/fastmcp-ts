import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const port = parseInt(process.env.MCP_PORT ?? '0', 10)
const path = '/mcp'

/** Sessions: mcp-session-id → transport */
const sessions = new Map()

function makeServer() {
  const server = new Server(
    { name: 'http-test-server', version: '1.0.0' },
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
    if (name === 'echo') return { content: [{ type: 'text', text: String(args?.message ?? '') }] }
    if (name === 'add') return { content: [{ type: 'text', text: String(Number(args?.a ?? 0) + Number(args?.b ?? 0)) }] }
    throw new Error(`Unknown tool: ${name}`)
  })

  server.setRequestHandler('resources/list', async () => ({ resources: [] }))
  server.setRequestHandler('prompts/list', async () => ({ prompts: [] }))

  return server
}

const httpServer = createServer(async (req, res) => {
  if (req.url?.split('?')[0] !== path) { res.writeHead(404).end(); return }

  const sessionId = req.headers['mcp-session-id']
  let transport

  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId)
  } else {
    transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
      onsessionclosed: (id) => sessions.delete(id),
    })
    const mcpServer = makeServer()
    await mcpServer.connect(transport)
  }

  await transport.handleRequest(req, res)
})

await new Promise((resolve, reject) => {
  httpServer.once('error', reject)
  httpServer.listen(port, '127.0.0.1', resolve)
})

const actualPort = httpServer.address().port
process.stderr.write(`listening on http://localhost:${actualPort}/mcp\n`)
