/**
 * Fixture FastMCP server exercising the metadata surface of
 * `inspect --format fastmcp`: server version, tool title + output schema,
 * resource mimeType + annotations, a resource template, and prompt arguments.
 */
import { FastMCP } from '../../src/server/index.js'
import { z } from 'zod'

const server = new FastMCP({ name: 'manifest-fixture', version: '2.3.4' })

server.tool(
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echo a message back',
    input: z.object({ message: z.string() }),
  },
  async ({ message }) => message,
)

server.tool(
  {
    name: 'add',
    description: 'Add two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
      required: ['sum'],
    },
  },
  async ({ a, b }) => ({ sum: a + b }),
)

server.resource(
  {
    uri: 'memo://greeting',
    name: 'greeting',
    description: 'A greeting',
    mimeType: 'text/plain',
    annotations: { audience: ['user'], priority: 0.5 },
  },
  () => 'Hello from resource!',
)

server.resource(
  { uri: 'user://{id}', name: 'user', description: 'User by id' },
  (params) => `User ${params?.id}`,
)

server.prompt(
  {
    name: 'greet',
    description: 'A greeting prompt',
    arguments: [
      { name: 'name', description: 'Who to greet', required: true },
      { name: 'tone' },
    ],
  },
  (args) => `Hello ${args?.name}!`,
)

await server.run()
