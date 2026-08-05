import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createOpenAPIServer } from 'fastmcp-ts/server'
import { connectEra, describeEachEra } from '../../helpers/eras'
import { runCli } from '../../helpers/cli.js'

/** Minimal upstream API stub: /ping and /notes/{id}, JSON responses. */
async function startStub(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url as string, 'http://stub')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.pathname === '/ping') {
      res.end(JSON.stringify({ pong: true }))
    } else if (url.pathname.startsWith('/notes/')) {
      res.end(JSON.stringify({ note: url.pathname.split('/').pop() }))
    } else {
      res.end(JSON.stringify({ path: url.pathname }))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())))
    },
  }
}

const ERA_SPEC = (baseUrl: string): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: { title: 'Era', version: '1.0.0' },
  servers: [{ url: baseUrl }],
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { pong: { type: 'boolean' } } },
              },
            },
          },
        },
      },
    },
    '/notes/{id}': {
      get: {
        operationId: 'getNote',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
})

describeEachEra('OpenAPI server across eras', (combo) => {
  it('lists, calls, and reads generated components', async () => {
    const stub = await startStub()
    const mcp = createOpenAPIServer({
      spec: ERA_SPEC(stub.url),
      routeMaps: [{ methods: ['GET'], pattern: '^/notes/', mcpType: 'resourceTemplate' }],
    })
    const { client, close } = await connectEra(mcp, combo)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['ping'])

      const result = await client.callTool({ name: 'ping', arguments: {} })
      expect(result.isError ?? false).toBe(false)
      expect(result.structuredContent).toEqual({ pong: true })

      const { resourceTemplates } = await client.listResourceTemplates()
      expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['resource://getNote/{id}'])

      const read = await client.readResource({ uri: 'resource://getNote/7' })
      expect(read.contents).toEqual([
        {
          uri: 'resource://getNote/7',
          mimeType: 'application/json',
          text: JSON.stringify({ note: '7' }),
        },
      ])
    } finally {
      await close()
      await stub.close()
    }
  })
})

// ---------------------------------------------------------------------------
// CLI smoke: the generated server works through the bundled CLI. This proves
// the OpenAPI modules bundle cleanly (no new dependencies) and serve stdio.
// ---------------------------------------------------------------------------

const OPENAPI_SERVER = resolve(import.meta.dirname, '../../fixtures/openapi-server.ts')

describe.sequential('CLI — inspect an OpenAPI-generated server', () => {
  it('lists the generated tools over inspect --file --json', async () => {
    const { exitCode, stdout } = await runCli([
      '--quiet',
      'inspect',
      '--file',
      OPENAPI_SERVER,
      '--json',
    ])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout) as {
      server?: { name?: string }
      tools: Array<{ name: string }>
    }
    const names = parsed.tools.map((t) => t.name)
    expect(names).toContain('listPets')
    expect(names).toContain('createShape')
    expect(names).toContain('duplicate_name_2')
  }, 30_000)
})
