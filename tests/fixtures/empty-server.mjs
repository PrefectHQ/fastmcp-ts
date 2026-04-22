/**
 * Fixture MCP server with no registered tools, resources, or prompts.
 * Used to verify empty-state rendering in inspect and list commands.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'empty-server', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }))
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }))

await server.connect(new StdioServerTransport())
