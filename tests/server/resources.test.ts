import { describe, it, expect } from 'vitest'
import { ProtocolError } from '@modelcontextprotocol/client'
import { FastMCP, ResourceResult } from 'fastmcp-ts/server'
import { connectEra, describeEachEra } from '../helpers/eras'

// ---------------------------------------------------------------------------
// Static resources — every case runs across all four transport/era combos.
// ---------------------------------------------------------------------------

describeEachEra('Server — Resources', (combo) => {
  describe('static resources', () => {
    it('a static text resource is readable by clients at its declared URI', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'memo://greeting', name: 'greeting' }, () => 'Hello, world!')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.readResource({ uri: 'memo://greeting' })
        expect(result.contents).toHaveLength(1)
        const content = result.contents[0] as { text: string; mimeType: string }
        expect(content.text).toBe('Hello, world!')
        expect(content.mimeType).toBe('text/plain')
      } finally {
        await close()
      }
    })

    it('a static binary resource returns blob content with the correct MIME type', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // PNG magic bytes
      mcp.resource({ uri: 'img://logo', name: 'logo', mimeType: 'image/png' }, () => bytes)
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.readResource({ uri: 'img://logo' })
        const content = result.contents[0] as { blob: string; mimeType: string }
        expect(content.blob).toBe(bytes.toString('base64'))
        expect(content.mimeType).toBe('image/png')
      } finally {
        await close()
      }
    })

    it('a static resource appears in resources/list', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'memo://note', name: 'note', description: 'A note' }, () => 'hi')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const { resources } = await client.listResources()
        expect(resources).toHaveLength(1)
        expect(resources[0].uri).toBe('memo://note')
        expect(resources[0].name).toBe('note')
        expect(resources[0].description).toBe('A note')
      } finally {
        await close()
      }
    })

    it('title, size, and annotations are forwarded in list responses', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource(
        {
          uri: 'memo://rich',
          name: 'rich',
          title: 'Rich Resource',
          size: 1024,
          annotations: { audience: ['user'], priority: 0.8 },
        },
        () => 'content',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const { resources } = await client.listResources()
        const r = resources[0] as Record<string, unknown>
        expect(r.title).toBe('Rich Resource')
        expect(r.size).toBe(1024)
        expect(r.annotations).toMatchObject({ audience: ['user'], priority: 0.8 })
      } finally {
        await close()
      }
    })

    it('title and annotations are forwarded for URI templates', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource(
        {
          uri: 'user://{id}',
          name: 'user',
          title: 'User Resource',
          annotations: { audience: ['assistant'] },
        },
        () => 'ok',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const { resourceTemplates } = await client.listResourceTemplates()
        const t = resourceTemplates[0] as Record<string, unknown>
        expect(t.title).toBe('User Resource')
        expect(t.annotations).toMatchObject({ audience: ['assistant'] })
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Dynamic resources
  // ---------------------------------------------------------------------------

  describe('dynamic resources', () => {
    it('a function-backed resource executes when its URI is requested', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let called = false
      mcp.resource({ uri: 'fn://counter' }, () => {
        called = true
        return 'executed'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        await client.readResource({ uri: 'fn://counter' })
        expect(called).toBe(true)
      } finally {
        await close()
      }
    })

    it('async resource functions are awaited before the response is sent', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'async://data' }, async () => {
        await new Promise((r) => setTimeout(r, 10))
        return 'async result'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.readResource({ uri: 'async://data' })
        const content = result.contents[0] as { text: string }
        expect(content.text).toBe('async result')
      } finally {
        await close()
      }
    })

    it('a function returning a plain object gets JSON-serialised into a text/json response', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'data://config' }, () => ({ host: 'localhost', port: 3000 }))
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.readResource({ uri: 'data://config' })
        const content = result.contents[0] as { text: string; mimeType: string }
        expect(content.mimeType).toBe('application/json')
        expect(JSON.parse(content.text)).toEqual({ host: 'localhost', port: 3000 })
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // URI templates
  // ---------------------------------------------------------------------------

  describe('URI templates', () => {
    it('a URI template is listed as a resource template, not a static resource', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'user://{id}', name: 'user' }, () => 'ok')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const { resources } = await client.listResources()
        expect(resources).toHaveLength(0)

        const { resourceTemplates } = await client.listResourceTemplates()
        expect(resourceTemplates).toHaveLength(1)
        expect(resourceTemplates[0].uriTemplate).toBe('user://{id}')
      } finally {
        await close()
      }
    })

    it('reading a URI matching a template calls the handler with extracted parameters', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let received: Record<string, string> | undefined
      mcp.resource({ uri: 'user://{id}', name: 'user' }, (params) => {
        received = params
        return `user ${params?.id}`
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.readResource({ uri: 'user://42' })
        expect(received).toEqual({ id: '42' })
        const content = result.contents[0] as { text: string }
        expect(content.text).toBe('user 42')
      } finally {
        await close()
      }
    })

    it('parameters in the URI pattern are extracted and passed to the function', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let received: Record<string, string> | undefined
      mcp.resource({ uri: 'repo://{owner}/{repo}/issues/{number}' }, (params) => {
        received = params
        return 'ok'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        await client.readResource({ uri: 'repo://acme/myapp/issues/99' })
        expect(received).toEqual({ owner: 'acme', repo: 'myapp', number: '99' })
      } finally {
        await close()
      }
    })

    it('wildcard path segments capture multiple URI segments', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let received: Record<string, string> | undefined
      mcp.resource({ uri: 'file:///{path*}' }, (params) => {
        received = params
        return 'ok'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        await client.readResource({ uri: 'file:///a/b/c/readme.txt' })
        expect(received).toEqual({ path: 'a/b/c/readme.txt' })
      } finally {
        await close()
      }
    })

    it('query parameters are extracted and passed as optional arguments', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let received: Record<string, string> | undefined
      mcp.resource({ uri: 'search://{query}{?limit,offset}' }, (params) => {
        received = params
        return 'ok'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        await client.readResource({ uri: 'search://typescript?limit=10&offset=20' })
        expect(received).toEqual({ query: 'typescript', limit: '10', offset: '20' })
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe('pagination', () => {
    it('resources/list returns the first page and a nextCursor when results exceed the page size', async () => {
      const mcp = new FastMCP({ name: 'test', resourcesPageSize: 2 })
      mcp.resource({ uri: 'r://a' }, () => 'a')
      mcp.resource({ uri: 'r://b' }, () => 'b')
      mcp.resource({ uri: 'r://c' }, () => 'c')
      const { client, close } = await connectEra(mcp, combo)
      try {
        // client.listResources() now auto-aggregates every page (v2 SDK behavior) —
        // use the low-level request() to observe a single raw page, matching what
        // this test is actually asserting about server-side pagination.
        const page1 = await client.request({ method: 'resources/list', params: {} })
        expect(page1.resources).toHaveLength(2)
        expect(page1.resources.map((r) => r.uri)).toEqual(['r://a', 'r://b'])
        expect(page1.nextCursor).toBeDefined()
      } finally {
        await close()
      }
    })

    it('supplying a cursor returns the next page of resources', async () => {
      const mcp = new FastMCP({ name: 'test', resourcesPageSize: 2 })
      mcp.resource({ uri: 'r://a' }, () => 'a')
      mcp.resource({ uri: 'r://b' }, () => 'b')
      mcp.resource({ uri: 'r://c' }, () => 'c')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const page1 = await client.request({ method: 'resources/list', params: {} })
        const page2 = await client.request({ method: 'resources/list', params: { cursor: page1.nextCursor } })
        expect(page2.resources).toHaveLength(1)
        expect(page2.resources[0].uri).toBe('r://c')
        expect(page2.nextCursor).toBeUndefined()
      } finally {
        await close()
      }
    })

    it('resources/templates/list is also paginated with cursor support', async () => {
      const mcp = new FastMCP({ name: 'test', resourcesPageSize: 2 })
      mcp.resource({ uri: 'r://{a}' }, () => 'a')
      mcp.resource({ uri: 'r://{b}' }, () => 'b')
      mcp.resource({ uri: 'r://{c}' }, () => 'c')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const page1 = await client.request({ method: 'resources/templates/list', params: {} })
        expect(page1.resourceTemplates).toHaveLength(2)
        expect(page1.nextCursor).toBeDefined()

        const page2 = await client.request({ method: 'resources/templates/list', params: { cursor: page1.nextCursor } })
        expect(page2.resourceTemplates).toHaveLength(1)
        expect(page2.nextCursor).toBeUndefined()
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Pagination (stale cursor)
  // ---------------------------------------------------------------------------

  describe('pagination (stale cursor)', () => {
    it('an invalid cursor for resources/list throws an InvalidParams error', async () => {
      const mcp = new FastMCP({ name: 'test', resourcesPageSize: 2 })
      mcp.resource({ uri: 'r://a', name: 'a' }, () => 'a')
      mcp.resource({ uri: 'r://b', name: 'b' }, () => 'b')

      const { client, close } = await connectEra(mcp, combo)
      try {
        await expect(
          client.listResources({ cursor: Buffer.from('r://nonexistent').toString('base64url') }),
        ).rejects.toThrow()
      } finally {
        await close()
      }
    })

    it('an invalid cursor for resources/templates/list throws an InvalidParams error', async () => {
      const mcp = new FastMCP({ name: 'test', resourcesPageSize: 2 })
      mcp.resource({ uri: 'r://{a}' }, () => 'a')
      mcp.resource({ uri: 'r://{b}' }, () => 'b')

      const { client, close } = await connectEra(mcp, combo)
      try {
        await expect(
          client.listResourceTemplates({ cursor: Buffer.from('r://{nonexistent}').toString('base64url') }),
        ).rejects.toThrow()
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('reading an unknown URI returns an error response', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const { client, close } = await connectEra(mcp, combo)
      try {
        await expect(client.readResource({ uri: 'unknown://nope' })).rejects.toThrow()
      } finally {
        await close()
      }
    })

    it('reading an unknown URI fails with -32602 (Invalid Params), not -32002', async () => {
      // SEP-2164 (2026-07-28): the resource-not-found error code moves from the
      // MCP-custom -32002 to the JSON-RPC standard -32602 Invalid Params — the URI
      // is a request parameter, not an unknown method.
      const mcp = new FastMCP({ name: 'test' })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const error = await client.readResource({ uri: 'unknown://nope' }).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ProtocolError)
        expect((error as ProtocolError).code).toBe(-32602)
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Timeout
  // ---------------------------------------------------------------------------

  describe('timeout', () => {
    it('a resource that exceeds its timeout returns an error', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'slow://data', timeout: 50 }, async () => {
        await new Promise((r) => setTimeout(r, 200))
        return 'too late'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        await expect(client.readResource({ uri: 'slow://data' })).rejects.toThrow(/timed out/)
      } finally {
        await close()
      }
    })

    it('a resource that completes within its timeout succeeds normally', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'fast://data', timeout: 500 }, async () => {
        await new Promise((r) => setTimeout(r, 10))
        return 'in time'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.readResource({ uri: 'fast://data' })
        const content = result.contents[0] as { text: string }
        expect(content.text).toBe('in time')
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Subscriptions (deferred — Python FastMCP does not implement these either)
  // ---------------------------------------------------------------------------

  describe('subscriptions', () => {
    it.todo('a client can subscribe to a resource URI')
    it.todo('the server sends notifications/resources/updated when a subscribed resource changes')
    it.todo('a client can unsubscribe and no longer receives update notifications')
    it.todo('the server advertises the subscribe and listChanged capabilities when enabled')
  })

  // ---------------------------------------------------------------------------
  // Visibility and lifecycle
  // ---------------------------------------------------------------------------

  describe('visibility and lifecycle', () => {
    it('a disabled resource does not appear in list responses', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'hidden://secret', disabled: true }, () => 'secret')
      mcp.resource({ uri: 'visible://public' }, () => 'public')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const { resources } = await client.listResources()
        expect(resources.map((r) => r.uri)).toEqual(['visible://public'])
      } finally {
        await close()
      }
    })

    it('reading a disabled resource returns an error', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'hidden://secret', disabled: true }, () => 'secret')
      const { client, close } = await connectEra(mcp, combo)
      try {
        await expect(client.readResource({ uri: 'hidden://secret' })).rejects.toThrow()
      } finally {
        await close()
      }
    })

    it('adding a resource surfaces it to clients (list_changed on legacy)', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const { client, close } = await connectEra(mcp, combo)
      try {
        if (combo.era === 'legacy') {
          // Legacy delivers list_changed as a server→client notification; over HTTP the
          // client must first open the standalone SSE stream (an initial list), stdio's
          // duplex is always open.
          await client.listResources()
          await new Promise((r) => setTimeout(r, 50))
          const notified = new Promise<void>((resolve) => {
            client.setNotificationHandler('notifications/resources/list_changed', () => resolve())
          })
          mcp.resource({ uri: 'dynamic://new' }, () => 'new')
          await notified
        } else {
          // Modern list_changed rides the subscriptions/listen bus, not a plain
          // notification; a raw client observes the change by re-listing.
          let fired = false
          client.setNotificationHandler('notifications/resources/list_changed', () => { fired = true })
          mcp.resource({ uri: 'dynamic://new' }, () => 'new')
          await new Promise((r) => setTimeout(r, 50))
          expect(fired).toBe(false)
          const { resources } = await client.listResources()
          expect(resources.map((r) => r.uri)).toContain('dynamic://new')
        }
      } finally {
        await close()
      }
    })
  })
})
