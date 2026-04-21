import { describe, it, expect, vi } from 'vitest'
import { FastMCP } from 'fastmcp-ts/server'
import { Client } from 'fastmcp-ts/client'
import type { Resource } from 'fastmcp-ts/client'

async function withServer(
  setup: (mcp: FastMCP) => void,
  fn: (client: Client) => Promise<void>,
) {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  setup(mcp)
  const client = await Client.connect(mcp)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

async function withServerExposed(
  setup: (mcp: FastMCP) => void,
  fn: (client: Client, mcp: FastMCP) => Promise<void>,
  clientOptions?: Parameters<typeof Client.connect>[1],
) {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  setup(mcp)
  const client = await Client.connect(mcp, clientOptions)
  try {
    await fn(client, mcp)
  } finally {
    await client.close()
  }
}

describe('Client — Resources', () => {
  describe('listResources()', () => {
    it('returns an array of static resource definitions', async () => {
      await withServer(
        (mcp) => {
          mcp.resource({ uri: 'file:///readme.md', name: 'README' }, () => '# hello')
        },
        async (client) => {
          const resources = await client.listResources()
          expect(resources).toBeInstanceOf(Array)
          const readme = resources.find((r) => r.name === 'README')
          expect(readme).toBeDefined()
          expect(readme!.uri).toBe('file:///readme.md')
        },
      )
    })
  })

  describe('listResourceTemplates()', () => {
    it('returns an array of URI template definitions', async () => {
      await withServer(
        (mcp) => {
          mcp.resource(
            { uri: 'file:///{path}', name: 'File' },
            ({ path }) => `content of ${path}`,
          )
        },
        async (client) => {
          const templates = await client.listResourceTemplates()
          expect(templates).toBeInstanceOf(Array)
          const tmpl = templates.find((t) => t.name === 'File')
          expect(tmpl).toBeDefined()
          expect(tmpl!.uriTemplate).toBe('file:///{path}')
        },
      )
    })
  })

  describe('readResource()', () => {
    it('returns text content for a text resource', async () => {
      await withServer(
        (mcp) => {
          mcp.resource({ uri: 'data:///hello', name: 'Hello' }, () => 'hello world')
        },
        async (client) => {
          const contents = await client.readResource('data:///hello')
          expect(contents).toBeInstanceOf(Array)
          expect(contents[0]).toMatchObject({ uri: 'data:///hello', text: 'hello world' })
        },
      )
    })

    it('resolves parameterised template URIs correctly', async () => {
      await withServer(
        (mcp) => {
          mcp.resource(
            { uri: 'item:///{id}', name: 'Item' },
            ({ id }) => `item:${id}`,
          )
        },
        async (client) => {
          const contents = await client.readResource('item:///42')
          expect(contents[0]).toMatchObject({ uri: 'item:///42', text: 'item:42' })
        },
      )
    })
  })

  describe('readResourceRaw()', () => {
    it('returns the raw SDK result object', async () => {
      await withServer(
        (mcp) => {
          mcp.resource({ uri: 'raw:///test', name: 'Test' }, () => 'raw content')
        },
        async (client) => {
          const raw = await client.readResourceRaw('raw:///test')
          expect(raw).toHaveProperty('contents')
          expect(raw.contents).toBeInstanceOf(Array)
        },
      )
    })
  })
})

describe('Client — onResourcesListChanged', () => {
  it('is called with the updated resource list when a resource is added after connect', async () => {
    const received: Array<{ error: Error | null; resources: Resource[] | null }> = []

    await withServerExposed(
      () => {},
      async (client, mcp) => {
        mcp.resource({ uri: 'data:///new', name: 'New' }, () => 'content')
        await vi.waitFor(() => {
          expect(received.length).toBeGreaterThan(0)
        }, { timeout: 2000 })
        const last = received[received.length - 1]!
        expect(last.error).toBeNull()
        const uris = last.resources?.map((r) => r.uri) ?? []
        expect(uris).toContain('data:///new')
      },
      {
        handlers: {
          onResourcesListChanged: {
            onChanged: (error, resources) => { received.push({ error, resources }) },
            debounceMs: 0,
          },
        },
      },
    )
  })
})
