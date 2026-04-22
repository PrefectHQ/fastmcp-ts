/**
 * Fixture HTTP MCP server for CLI integration tests.
 * Uses the MCP SDK directly with explicit .js imports so it runs cleanly
 * under `node` without a bundle step.
 *
 * Reads MCP_PORT from the environment (0 = OS-assigned ephemeral port).
 * Writes "listening on http://localhost:PORT/mcp" to stderr once ready so
 * the test harness can read the actual bound port.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from 'node:http'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    if (name === 'echo') return { content: [{ type: 'text', text: String(args?.message ?? '') }] }
    if (name === 'add') return { content: [{ type: 'text', text: String(Number(args?.a ?? 0) + Number(args?.b ?? 0)) }] }
    throw new Error(`Unknown tool: ${name}`)
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }))
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }))

  return server
}

const httpServer = createServer(async (req, res) => {
  if (req.url?.split('?')[0] !== path) { res.writeHead(404).end(); return }

  const sessionId = req.headers['mcp-session-id']
  let transport

  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId)
  } else {
    transport = new StreamableHTTPServerTransport({
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
