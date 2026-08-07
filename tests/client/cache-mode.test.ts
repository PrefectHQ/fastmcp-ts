import { describe, expect, it } from 'vitest'
import { Client, MultiServerClient } from 'fastmcp-ts/client'
import type { ClientOptions, Tool } from 'fastmcp-ts/client'
import { FastMCP } from 'fastmcp-ts/server'

function modernOptions(): Pick<ClientOptions, 'versionNegotiation'> {
  return { versionNegotiation: { mode: { pin: '2026-07-28' } } }
}

describe('Client cache modes', () => {
  it('uses a fresh cached list by default and refresh replaces it', async () => {
    let requests = 0
    const mcp = new FastMCP({
      name: 'cache-list',
      version: '1.0.0',
      cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } },
    })
    mcp.tool({ name: 'cached', description: 'cached tool' }, () => 'ok')
    mcp.use({
      async onListTools(_ctx, next) {
        requests++
        const result = (await next()) as { tools: Tool[] }
        return {
          ...result,
          tools: result.tools.map((tool) => ({ ...tool, description: `version ${requests}` })),
        }
      },
    })

    const client = await Client.connect(mcp, modernOptions())
    try {
      const first = await client.listTools()
      const reused = await client.listTools()
      const refreshed = await client.listTools({ cacheMode: 'refresh' })
      const reusedAfterRefresh = await client.listTools()

      expect(first[0]?.description).toBe('version 1')
      expect(reused[0]?.description).toBe('version 1')
      expect(refreshed[0]?.description).toBe('version 2')
      expect(reusedAfterRefresh[0]?.description).toBe('version 2')
      expect(requests).toBe(2)
    } finally {
      await client.close()
      await mcp.close()
    }
  })

  it('bypass skips both reading and replacing a cached entry', async () => {
    let reads = 0
    const mcp = new FastMCP({
      name: 'cache-bypass',
      version: '1.0.0',
      cacheHints: { 'resources/read': { ttlMs: 60_000, cacheScope: 'public' } },
    })
    mcp.resource({ uri: 'data:///bypass', name: 'bypass' }, () => `value ${++reads}`)

    const client = await Client.connect(mcp, modernOptions())
    try {
      const cached = await client.readResource('data:///bypass')
      const bypassed = await client.readResource('data:///bypass', { cacheMode: 'bypass' })
      const reused = await client.readResource('data:///bypass')

      expect(cached[0]).toMatchObject({ text: 'value 1' })
      expect(bypassed[0]).toMatchObject({ text: 'value 2' })
      expect(reused[0]).toMatchObject({ text: 'value 1' })
      expect(reads).toBe(2)
    } finally {
      await client.close()
      await mcp.close()
    }
  })

  it('keeps legacy cacheable requests functional when cacheMode is supplied', async () => {
    const mcp = new FastMCP({ name: 'legacy-cache-mode', version: '1.0.0' })
    mcp.tool({ name: 'legacy', description: 'legacy tool' }, () => 'ok')

    const client = await Client.connect(mcp, {
      versionNegotiation: { mode: 'legacy' },
    })
    try {
      await expect(client.listTools({ cacheMode: 'refresh' })).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'legacy' })]),
      )
    } finally {
      await client.close()
      await mcp.close()
    }
  })

  it('forwards refresh to every server in a multi-server client', async () => {
    const requests = { a: 0, b: 0 }
    const a = cachedToolServer('a', () => requests.a++)
    const b = cachedToolServer('b', () => requests.b++)
    const client = await MultiServerClient.connect(
      { mcpServers: { a, b } },
      modernOptions(),
    )

    try {
      await client.listTools()
      await client.listTools()
      expect(requests).toEqual({ a: 1, b: 1 })

      await client.listTools({ cacheMode: 'refresh' })
      expect(requests).toEqual({ a: 2, b: 2 })
    } finally {
      await client.close()
      await a.close()
      await b.close()
    }
  })
})

function cachedToolServer(name: string, onList: () => void): FastMCP {
  const mcp = new FastMCP({
    name,
    version: '1.0.0',
    cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } },
  })
  mcp.tool({ name: 'cached', description: 'cached tool' }, () => 'ok')
  mcp.use({
    async onListTools(_ctx, next) {
      onList()
      return next()
    },
  })
  return mcp
}
