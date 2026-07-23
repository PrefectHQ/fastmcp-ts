import { describe, it, expect, vi } from 'vitest'
import { FastMCP, staticTokenVerifier, requireScopes, inputRequired, acceptedContent } from 'fastmcp-ts/server'
import {
  LoggingMiddleware,
  CachingMiddleware,
  RateLimitingMiddleware,
  SizeLimitingMiddleware,
  ErrorNormalizationMiddleware,
  CancellationMiddleware,
} from 'fastmcp-ts/server'
import type { Middleware, MiddlewareContext, Next, McpContext, AccessToken } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'
import { connectHttpClient } from '../helpers/http'
import { connectEra, ERA_COMBOS } from '../helpers/eras'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe('Server — Middleware', () => {
  describe('pipeline', () => {
    it('middleware runs before the handler and can inspect the request', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'echo', description: 'echo' }, () => 'ok')

      const seen: unknown[] = []
      const mw: Middleware = {
        async onRequest(ctx, next) {
          seen.push(ctx.request)
          return next()
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'echo', arguments: {} })
        expect(seen).toHaveLength(1)
        expect((seen[0] as { name: string }).name).toBe('echo')
      } finally {
        await close()
      }
    })

    it('middleware runs after the handler and can inspect the response', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'echo', description: 'echo' }, () => 'hello')

      const responses: unknown[] = []
      const mw: Middleware = {
        async onRequest(ctx, next) {
          const result = await next()
          responses.push(result)
          return result
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'echo', arguments: {} })
        expect(responses).toHaveLength(1)
        expect(JSON.stringify(responses[0])).toContain('hello')
      } finally {
        await close()
      }
    })

    it('middleware can short-circuit the pipeline and return early', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const handlerSpy = vi.fn(() => 'real response')
      mcp.tool({ name: 'echo', description: 'echo' }, handlerSpy)

      const mw: Middleware = {
        async onRequest(_ctx, _next) {
          // Short-circuit: never call next()
          return {
            content: [{ type: 'text' as const, text: 'short-circuited' }],
          }
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'echo', arguments: {} })
        expect(handlerSpy).not.toHaveBeenCalled()
        expect((result as { content: { type: string; text: string }[] }).content[0]).toMatchObject({ type: 'text', text: 'short-circuited' })
      } finally {
        await close()
      }
    })

    it('multiple middleware layers execute in registration order on the way in and reverse on the way out', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'echo', description: 'echo' }, () => 'ok')

      const log: string[] = []

      const makeLayer = (name: string): Middleware => ({
        async onRequest(ctx, next) {
          log.push(`${name} in`)
          const result = await next()
          log.push(`${name} out`)
          return result
        },
      })

      mcp.use(makeLayer('A'))
      mcp.use(makeLayer('B'))
      mcp.use(makeLayer('C'))

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'echo', arguments: {} })
        expect(log).toEqual(['A in', 'B in', 'C in', 'C out', 'B out', 'A out'])
      } finally {
        await close()
      }
    })

    it('setup() is called on the primary server synchronously when middleware is registered via use()', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      let setupCalled = false
      let setupReceivedServer = false

      const mw: Middleware = {
        setup(server) {
          setupCalled = true
          setupReceivedServer = typeof server.setNotificationHandler === 'function'
        },
      }

      mcp.use(mw)

      // setup() must have been called synchronously by use(), before connect()
      expect(setupCalled).toBe(true)
      expect(setupReceivedServer).toBe(true)

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Built-in middleware
  // ---------------------------------------------------------------------------

  describe('built-in middleware', () => {
    it('request logging middleware emits structured logs for every operation', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      const logs: string[] = []
      mcp.use(new LoggingMiddleware((msg) => logs.push(msg)))

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
        expect(logs.some((l) => l.includes('tools/call') && l.includes('→'))).toBe(true)
        expect(logs.some((l) => l.includes('tools/call') && l.includes('←'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('caching middleware returns a stored response for repeated identical requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let callCount = 0
      mcp.tool({ name: 'count', description: 'count' }, () => {
        callCount++
        return `call ${callCount}`
      })

      mcp.use(new CachingMiddleware(60_000))

      const { client, close } = await createTestClient(mcp)
      try {
        const r1 = await client.callTool({ name: 'count', arguments: {} })
        const r2 = await client.callTool({ name: 'count', arguments: {} })
        expect(callCount).toBe(1)
        expect(r1.content).toEqual(r2.content)
      } finally {
        await close()
      }
    })

    it('caching middleware with a keyFn isolates cached results per caller identity', async () => {
      // A caller-supplied keyFn fully owns partitioning. A keyFn scoped to clientId
      // isolates each identity's cached list. (The DEFAULT key is auth-aware too — see
      // the default-partitioning tests below — but a keyFn replaces that default, so its
      // owner is responsible for including identity, as this keyFn does via clientId.)
      // This test requires the HTTP transport because extra.authInfo (and therefore
      // ctx.mcpContext.auth) is only populated on the bearer-auth path.
      const adminToken = 'admin-token'
      const userToken = 'user-token'

      const mcp = new FastMCP({
        name: 'test',
        auth: staticTokenVerifier({
          [adminToken]: { clientId: 'admin', scopes: ['admin', 'read'], claims: {} },
          [userToken]: { clientId: 'user', scopes: ['read'], claims: {} },
        }),
      })

      // Public tool — visible to everyone
      mcp.tool({ name: 'public', description: 'public tool' }, () => 'ok')
      // Admin-only tool — filtered out for the user token
      mcp.tool({ name: 'admin-only', description: 'admin tool', auth: requireScopes('admin') }, () => 'ok')

      // keyFn partitions by clientId so each identity gets its own cache bucket
      mcp.use(new CachingMiddleware(60_000, (ctx) =>
        `${ctx.method}:${ctx.mcpContext.auth?.clientId ?? ''}:${JSON.stringify(ctx.request)}`
      ))

      await mcp.run({ transport: 'http', port: 0 })
      const url = new URL(`http://127.0.0.1:${mcp.address!.port}${mcp.address!.path}`)

      const { client: adminClient, close: closeAdmin } = await connectHttpClient(url, adminToken)
      const { client: userClient, close: closeUser } = await connectHttpClient(url, userToken)
      try {
        // Admin sees both tools; result is cached under the admin key
        const adminList = await adminClient.listTools()
        expect(adminList.tools.map((t) => t.name)).toContain('admin-only')

        // User must get their own filtered list, NOT the admin's cached result
        const userList = await userClient.listTools()
        expect(userList.tools.map((t) => t.name)).not.toContain('admin-only')
        expect(userList.tools.map((t) => t.name)).toContain('public')
      } finally {
        await closeAdmin()
        await closeUser()
        await mcp.close()
      }
    })

    it('caching middleware does not cache or replay an inputRequired round-trip', async () => {
      // Regression (task-9 Req 4; repro from .tmp/sdd/task-3-report.md): a multi-round-trip
      // retry re-sends byte-identical tools/call params — inputResponses / requestState are
      // lifted out of params by the SDK, so the default cache key is identical across rounds.
      // The old CachingMiddleware cached round 1's `input_required` result and replayed it on
      // round 2, so the handler never saw the client's answer and the tool never completed.
      // The fix (exclusion rule): never serve/store when the request carries inputResponses
      // or requestState, and never store an `input_required` result.
      let rounds = 0
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'confirmDelete', description: 'Delete after confirmation' },
        async () => {
          rounds++
          const ctx = mcp.getContext()
          const accepted = acceptedContent<{ confirm: boolean }>(ctx.inputResponses, 'confirm')
          if (!accepted?.confirm) {
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: 'Confirm delete?',
                  requestedSchema: {
                    type: 'object',
                    properties: { confirm: { type: 'boolean' } },
                    required: ['confirm'],
                  },
                }),
              },
            })
          }
          return 'deleted'
        },
      )
      mcp.use(new CachingMiddleware(60_000))
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })

      const url = `http://127.0.0.1:${mcp.address!.port}/mcp`
      const envelopeMeta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
      }
      const headers = {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'confirmDelete',
      }

      try {
        // Round 1 — no inputResponses: the handler returns input_required. This result must
        // NOT be cached (each carries a single-use flow token; caching would replay it).
        const res1 = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'confirmDelete', arguments: {}, _meta: envelopeMeta },
          }),
        })
        const body1 = await res1.json()
        expect(body1.result.resultType).toBe('input_required')

        // Round 2 — retry with inputResponses (byte-identical params otherwise). The cache
        // must be bypassed so the handler re-runs and completes, rather than replaying the
        // cached round-1 input_required result.
        const res2 = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'confirmDelete',
              arguments: {},
              inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
              _meta: envelopeMeta,
            },
          }),
        })
        const body2 = await res2.json()
        expect(body2.result.content).toEqual([{ type: 'text', text: 'deleted' }])
        // The handler ran on BOTH rounds — proof the cache never short-circuited the retry.
        expect(rounds).toBe(2)
      } finally {
        await mcp.close()
      }
    })

    it('caching middleware does not cache side-effectful resources/subscribe (re-subscribe re-establishes delivery)', async () => {
      // Regression (task-15 seam 1): CachingMiddleware keys on method + params, and
      // task-11 routed resources/subscribe / unsubscribe through the middleware chain.
      // subscribe → unsubscribe → subscribe sends byte-identical subscribe params, so
      // the second subscribe would hit the cached {} from the first WITHOUT re-running
      // the handler — the client believes it re-subscribed, but the per-session
      // subscription set no longer contains the URI (unsubscribe removed it), so
      // notifyResourceUpdated delivers nothing. Rule (same class as the inputRequired
      // exclusion above): never cache side-effectful control methods.
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'watch://res', name: 'res' }, () => 'v1')
      mcp.use(new CachingMiddleware(60_000))

      // subscribe/unsubscribe are live RPCs only on the legacy era; connect a legacy
      // combo where notifyResourceUpdated actually pushes to the live session.
      const legacyStdio = ERA_COMBOS.find((c) => c.name === 'stdio-legacy')!
      const { client, close } = await connectEra(mcp, legacyStdio)
      try {
        const updates: string[] = []
        client.setNotificationHandler('notifications/resources/updated', (n: unknown) => {
          updates.push((n as { params: { uri: string } }).params.uri)
        })
        const waitFor = async (pred: () => boolean, ms = 500): Promise<void> => {
          const start = Date.now()
          while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10))
        }

        await client.subscribeResource({ uri: 'watch://res' })
        await client.unsubscribeResource({ uri: 'watch://res' })
        // Second subscribe: params are byte-identical to the first. It MUST re-run the
        // handler (re-add the URI), not replay the cached {} from the first subscribe.
        await client.subscribeResource({ uri: 'watch://res' })

        mcp.notifyResourceUpdated('watch://res')
        await waitFor(() => updates.length >= 1)
        // Delivery proves the re-subscribe genuinely re-established the subscription.
        expect(updates).toEqual(['watch://res'])
      } finally {
        await close()
      }
    })

    it('caching middleware default key partitions auth-scoped tools/list visibility across sessions (no keyFn)', async () => {
      // Leak repro (task-17; finding names "tools/list (auth-scoped visibility!)").
      // tools/list filters the tool set by the caller's token INSIDE the handler, so a
      // cache hit taken before that filter runs serves one identity's visibility to
      // another. With the DEFAULT (now auth-aware) key and NO keyFn, the admin's cached
      // list must NOT reach the user.
      // Transport: legacy-sessionful HTTP. Auth material (ctx.mcpContext.auth) is
      // populated only on the bearer HTTP path (stdio carries no bearer; a no-auth
      // server never populates it), so this leak can only be exercised over bearer HTTP
      // — the same combo the existing keyFn test uses.
      const adminToken = 'admin-token'
      const userToken = 'user-token'
      const mcp = new FastMCP({
        name: 'test',
        auth: staticTokenVerifier({
          [adminToken]: { clientId: 'admin', scopes: ['admin', 'read'], claims: {} },
          [userToken]: { clientId: 'user', scopes: ['read'], claims: {} },
        }),
      })
      mcp.tool({ name: 'public', description: 'public tool' }, () => 'ok')
      mcp.tool({ name: 'admin-only', description: 'admin tool', auth: requireScopes('admin') }, () => 'ok')

      // DEFAULT key — no keyFn. Pre-fix this leaks; post-fix it partitions by identity.
      mcp.use(new CachingMiddleware(60_000))

      await mcp.run({ transport: 'http', port: 0 })
      const url = new URL(`http://127.0.0.1:${mcp.address!.port}${mcp.address!.path}`)
      const { client: adminClient, close: closeAdmin } = await connectHttpClient(url, adminToken)
      const { client: userClient, close: closeUser } = await connectHttpClient(url, userToken)
      try {
        // Admin sees both tools; result is cached under the admin partition.
        const adminList = await adminClient.listTools()
        expect(adminList.tools.map((t) => t.name)).toContain('admin-only')

        // User must get their OWN filtered list from their own partition, NOT the
        // admin's cached result.
        const userList = await userClient.listTools()
        expect(userList.tools.map((t) => t.name)).not.toContain('admin-only')
        expect(userList.tools.map((t) => t.name)).toContain('public')
      } finally {
        await closeAdmin()
        await closeUser()
        await mcp.close()
      }
    })

    it('caching middleware default key does not serve one identity\'s cached resource read to another, and rejects the unauthorized (no keyFn)', async () => {
      // Leak repro — the worst case (task-17; finding: "resources/read contents being
      // the worst case"). An auth-gated resource whose contents depend on the caller
      // identity: with the DEFAULT (auth-aware) key and NO keyFn, each identity must get
      // its OWN cached contents, and a caller lacking the required scope must get read's
      // auth rejection — never the cached contents. Legacy-sessionful HTTP (see above).
      const adminToken = 'admin-token'
      const userToken = 'user-token'
      const noReadToken = 'noread-token'
      const mcp = new FastMCP({
        name: 'test',
        auth: staticTokenVerifier({
          [adminToken]: { clientId: 'admin', scopes: ['read'], claims: {} },
          [userToken]: { clientId: 'user', scopes: ['read'], claims: {} },
          [noReadToken]: { clientId: 'nobody', scopes: [], claims: {} },
        }),
      })
      // Gated on 'read'; contents are identity-specific.
      mcp.resource({ uri: 'secret://data', name: 'secret', auth: requireScopes('read') }, () =>
        `secret-for-${mcp.getContext().auth?.clientId ?? 'anon'}`,
      )
      mcp.use(new CachingMiddleware(60_000))

      await mcp.run({ transport: 'http', port: 0 })
      const url = new URL(`http://127.0.0.1:${mcp.address!.port}${mcp.address!.path}`)
      const { client: adminClient, close: closeAdmin } = await connectHttpClient(url, adminToken)
      const { client: userClient, close: closeUser } = await connectHttpClient(url, userToken)
      const { client: noReadClient, close: closeNoRead } = await connectHttpClient(url, noReadToken)
      try {
        const adminRead = await adminClient.readResource({ uri: 'secret://data' })
        expect((adminRead.contents[0] as { text: string }).text).toBe('secret-for-admin')

        // A different authorized identity must get its OWN contents, never the admin's
        // cached secret. (Pre-fix the default key ignores identity → this is the leak.)
        const userRead = await userClient.readResource({ uri: 'secret://data' })
        expect((userRead.contents[0] as { text: string }).text).toBe('secret-for-user')

        // Unauthorized (lacks 'read'): read's own auth rejection, never the cached secret.
        await expect(noReadClient.readResource({ uri: 'secret://data' })).rejects.toThrow(/scope/i)
      } finally {
        await closeAdmin()
        await closeUser()
        await closeNoRead()
        await mcp.close()
      }
    })

    it('caching middleware default key still serves a cache hit for the same identity (no keyFn)', async () => {
      // Same-identity caching must survive partitioning: two reads under the SAME token
      // land in one partition, so the handler runs once. Asserted by a handler-invocation
      // counter (timing-free). Legacy-sessionful HTTP.
      const adminToken = 'admin-token'
      let calls = 0
      const mcp = new FastMCP({
        name: 'test',
        auth: staticTokenVerifier({ [adminToken]: { clientId: 'admin', scopes: ['read'], claims: {} } }),
      })
      mcp.resource({ uri: 'data://count', name: 'count', auth: requireScopes('read') }, () => {
        calls++
        return `call-${calls}`
      })
      mcp.use(new CachingMiddleware(60_000))
      await mcp.run({ transport: 'http', port: 0 })
      const url = new URL(`http://127.0.0.1:${mcp.address!.port}${mcp.address!.path}`)
      const { client, close } = await connectHttpClient(url, adminToken)
      try {
        const r1 = await client.readResource({ uri: 'data://count' })
        const r2 = await client.readResource({ uri: 'data://count' })
        // Handler ran once — the second read was served from the same-identity partition.
        expect(calls).toBe(1)
        expect((r1.contents[0] as { text: string }).text).toBe('call-1')
        expect((r2.contents[0] as { text: string }).text).toBe('call-1')
      } finally {
        await close()
        await mcp.close()
      }
    })

    it('caching middleware default key keeps anonymous and authenticated identities in separate partitions (both directions)', async () => {
      // Anonymous (ctx.mcpContext.auth === undefined) must never share a partition with
      // any authenticated identity, in EITHER direction. A real auth-configured HTTP
      // server 401s every tokenless request, and a no-auth server never populates
      // ctx.auth, so anon and authenticated requests never share one live cache through a
      // transport — the separation is a property of the default key. This drives
      // CachingMiddleware.onRequest directly with both ctx shapes; a counting handler is
      // the timing-free signal. (Transport does not matter here — the invariant is the
      // key, not the wire — so no era combo is exercised, unlike the tests above.)
      const authed = { token: 'tok-A', clientId: 'A', scopes: [], claims: {} } as AccessToken

      const mkCtx = (auth: AccessToken | undefined): MiddlewareContext => ({
        method: 'resources/read',
        request: { uri: 'x' },
        mcpContext: { auth, inputResponses: undefined, requestState: () => undefined } as unknown as McpContext,
      })

      // Direction 1: anonymous writes first; the authenticated identity must miss it.
      {
        const mw = new CachingMiddleware(60_000)
        let calls = 0
        const handler = async () => { calls++; return `v${calls}` }
        const anon = await mw.onRequest(mkCtx(undefined), handler) // miss -> v1, cached anon
        const auth = await mw.onRequest(mkCtx(authed), handler)    // must MISS anon -> v2
        expect(calls).toBe(2)
        expect(anon).toBe('v1')
        expect(auth).toBe('v2')
        // Each identity re-reads its OWN partition (no extra handler run).
        expect(await mw.onRequest(mkCtx(undefined), handler)).toBe('v1')
        expect(await mw.onRequest(mkCtx(authed), handler)).toBe('v2')
        expect(calls).toBe(2)
      }

      // Direction 2: authenticated writes first; anonymous must miss it.
      {
        const mw = new CachingMiddleware(60_000)
        let calls = 0
        const handler = async () => { calls++; return `v${calls}` }
        const auth = await mw.onRequest(mkCtx(authed), handler)    // miss -> v1, cached auth
        const anon = await mw.onRequest(mkCtx(undefined), handler) // must MISS auth -> v2
        expect(calls).toBe(2)
        expect(auth).toBe('v1')
        expect(anon).toBe('v2')
      }
    })

    it('a custom keyFn replaces the default auth partitioning (its owner owns partitioning)', async () => {
      // Overriding the key removes the built-in auth partitioning entirely — the keyFn
      // owns partitioning. A keyFn that ignores identity (constant per method+params)
      // makes two DIFFERENT authenticated identities SHARE one cache entry, proving the
      // default partitioning was replaced (not merely augmented). This is the documented
      // trade-off: custom keyFn owners own their own partitioning. Legacy-sessionful HTTP.
      const adminToken = 'admin-token'
      const userToken = 'user-token'
      const mcp = new FastMCP({
        name: 'test',
        auth: staticTokenVerifier({
          [adminToken]: { clientId: 'admin', scopes: ['read'], claims: {} },
          [userToken]: { clientId: 'user', scopes: ['read'], claims: {} },
        }),
      })
      mcp.resource({ uri: 'shared://data', name: 'shared', auth: requireScopes('read') }, () =>
        `contents-for-${mcp.getContext().auth?.clientId ?? 'anon'}`,
      )
      // keyFn deliberately ignores auth: identity is NOT in the key.
      mcp.use(new CachingMiddleware(60_000, (ctx) => `${ctx.method}:${JSON.stringify(ctx.request)}`))
      await mcp.run({ transport: 'http', port: 0 })
      const url = new URL(`http://127.0.0.1:${mcp.address!.port}${mcp.address!.path}`)
      const { client: adminClient, close: closeAdmin } = await connectHttpClient(url, adminToken)
      const { client: userClient, close: closeUser } = await connectHttpClient(url, userToken)
      try {
        const adminRead = await adminClient.readResource({ uri: 'shared://data' })
        expect((adminRead.contents[0] as { text: string }).text).toBe('contents-for-admin')
        // keyFn ignored identity, so the user is served the admin's cached entry — proof
        // the keyFn replaced the default partitioning (callers who override own this).
        const userRead = await userClient.readResource({ uri: 'shared://data' })
        expect((userRead.contents[0] as { text: string }).text).toBe('contents-for-admin')
      } finally {
        await closeAdmin()
        await closeUser()
        await mcp.close()
      }
    })

    it('rate limiting middleware rejects requests that exceed the configured limit', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'ok')

      // limit=1 per very long window so the second call is always rejected
      mcp.use(new RateLimitingMiddleware(1, 60_000))

      const { client, close } = await createTestClient(mcp)
      try {
        // First call consumes the single token — must succeed
        await client.callTool({ name: 'ping', arguments: {} })
        // Second call: RateLimitingMiddleware throws McpError which the tool handler
        // re-throws as a protocol-level error, causing the client to reject
        await expect(
          client.callTool({ name: 'ping', arguments: {} }),
        ).rejects.toThrow('Rate limit exceeded')
      } finally {
        await close()
      }
    })

    it('size-limiting middleware rejects responses that exceed the configured byte threshold', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'big', description: 'big' }, () => 'x'.repeat(1000))

      mcp.use(new SizeLimitingMiddleware(10))

      const { client, close } = await createTestClient(mcp)
      try {
        // McpError thrown by middleware propagates as a protocol-level error
        await expect(client.callTool({ name: 'big', arguments: {} })).rejects.toThrow()
      } finally {
        await close()
      }
    })

    it('error normalization middleware maps thrown errors to correct MCP error codes and shapes', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'data://broken', name: 'broken' }, () => {
        throw new Error('something went wrong')
      })

      mcp.use(new ErrorNormalizationMiddleware())

      const { client, close } = await createTestClient(mcp)
      try {
        // Without normalization a plain Error becomes an unhandled rejection → SDK wraps it.
        // With ErrorNormalizationMiddleware it becomes McpError(InternalError).
        await expect(client.readResource({ uri: 'data://broken' })).rejects.toThrow(
          /something went wrong/,
        )
      } finally {
        await close()
      }
    })

    it('ErrorNormalizationMiddleware does not swallow McpError thrown by downstream middleware on tools/call', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'ok')

      // ErrorNormalizationMiddleware registered first, RateLimitingMiddleware second.
      // Previously onCallTool caught all errors including McpError, so the rate-limit
      // McpError was silently converted to { isError: true } instead of a protocol error.
      mcp.use(new ErrorNormalizationMiddleware())
      mcp.use(new RateLimitingMiddleware(1, 60_000))

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
        await expect(
          client.callTool({ name: 'ping', arguments: {} }),
        ).rejects.toThrow('Rate limit exceeded')
      } finally {
        await close()
      }
    })

    it('cancellation middleware intercepts notifications/cancelled and aborts the in-flight handler', async () => {
      // This test exercises the SERVER-SIDE cancellation path. When the client AbortController
      // fires, the SDK sends a notifications/cancelled message to the server. Because use() now
      // calls setup() on the primary server immediately (see the use() fix), CancellationMiddleware
      // registers the notifications/cancelled handler before connect(), so the server races the
      // in-flight handler against an abort promise and rejects early.
      const mcp = new FastMCP({ name: 'test' })
      let handlerStarted = false

      mcp.tool({ name: 'slow', description: 'slow' }, async () => {
        handlerStarted = true
        await new Promise((r) => setTimeout(r, 5_000))
        return 'done'
      })

      mcp.use(new CancellationMiddleware())

      const { client, close } = await createTestClient(mcp)
      try {
        const controller = new AbortController()
        const callPromise = client.callTool({ name: 'slow', arguments: {} }, {
          signal: controller.signal,
        })

        // (a) Wait long enough for the handler to start executing on the server
        await new Promise((r) => setTimeout(r, 30))
        expect(handlerStarted).toBe(true)

        // (b) Abort — SDK sends notifications/cancelled; CancellationMiddleware aborts the race
        controller.abort()

        // (c) The call must reject — server rejected via the abort race, not just client dropout
        await expect(callPromise).rejects.toThrow()
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Per-method hooks
  // ---------------------------------------------------------------------------

  describe('per-method hooks', () => {
    it('on_call_tool hook fires only for tools/call requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')
      mcp.resource({ uri: 'data://x', name: 'x' }, () => 'data')

      const toolHook = vi.fn((_ctx: MiddlewareContext, next: Next) => next())
      const requestHook = vi.fn((_ctx: MiddlewareContext, next: Next) => next())

      mcp.use({
        onCallTool: toolHook,
        onRequest: requestHook,
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
        await client.readResource({ uri: 'data://x' })

        // onCallTool fired once (for tools/call), not for resources/read
        expect(toolHook).toHaveBeenCalledTimes(1)
        // onRequest fired once (for resources/read — no specific hook matched)
        expect(requestHook).toHaveBeenCalledTimes(1)
        expect((requestHook.mock.calls[0][0] as MiddlewareContext).method).toBe('resources/read')
      } finally {
        await close()
      }
    })

    it('on_list_tools hook fires only for tools/list requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      const fired: string[] = []
      mcp.use({
        onListTools: (_ctx, next) => { fired.push('list-tools'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.listTools()
        expect(fired).toContain('list-tools')
        expect(fired.every((e) => !e.startsWith('request:tools/list'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_read_resource hook fires only for resources/read requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'data://x', name: 'x' }, () => 'data')

      const fired: string[] = []
      mcp.use({
        onReadResource: (_ctx, next) => { fired.push('read-resource'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.readResource({ uri: 'data://x' })
        expect(fired).toContain('read-resource')
        expect(fired.every((e) => !e.startsWith('request:resources/read'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_list_resources hook fires only for resources/list requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'data://x', name: 'x' }, () => 'data')

      const fired: string[] = []
      mcp.use({
        onListResources: (_ctx, next) => { fired.push('list-resources'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.listResources()
        expect(fired).toContain('list-resources')
        expect(fired.every((e) => !e.startsWith('request:resources/list'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_list_resource_templates hook fires only for resources/templates/list requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      // URI containing '{' routes to _templateResources
      mcp.resource({ uri: 'data://{id}', name: 'dynamic' }, () => 'data')

      const fired: string[] = []
      mcp.use({
        onListResourceTemplates: (_ctx, next) => { fired.push('list-resource-templates'); return next() },
        onListResources: (_ctx, next) => { fired.push('list-resources'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.listResourceTemplates()
        // The specific hook must have fired
        expect(fired).toContain('list-resource-templates')
        // onListResources must NOT fire for a templates/list call (regression guard for the bug
        // where both handlers used the 'resources/list' method string)
        expect(fired).not.toContain('list-resources')
        // onRequest must NOT fire — the specific hook takes precedence
        expect(fired.every((e) => !e.startsWith('request:resources/templates/list'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_get_prompt hook fires only for prompts/get requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'greet', description: 'greet' }, () => 'Hello!')

      const fired: string[] = []
      mcp.use({
        onGetPrompt: (_ctx, next) => { fired.push('get-prompt'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.getPrompt({ name: 'greet', arguments: {} })
        expect(fired).toContain('get-prompt')
        expect(fired.every((e) => !e.startsWith('request:prompts/get'))).toBe(true)
      } finally {
        await close()
      }
    })

    it('on_list_prompts hook fires only for prompts/list requests', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'greet', description: 'greet' }, () => 'Hello!')

      const fired: string[] = []
      mcp.use({
        onListPrompts: (_ctx, next) => { fired.push('list-prompts'); return next() },
        onRequest: (ctx, next) => { fired.push(`request:${ctx.method}`); return next() },
      })

      const { client, close } = await createTestClient(mcp)
      try {
        await client.listPrompts()
        expect(fired).toContain('list-prompts')
        expect(fired.every((e) => !e.startsWith('request:prompts/list'))).toBe(true)
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Custom middleware
  // ---------------------------------------------------------------------------

  describe('custom middleware', () => {
    it('a custom middleware function receives the request, a next() callback, and the context', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'ping', description: 'ping' }, () => 'pong')

      let captured: { method: string; hasNext: boolean; hasContext: boolean } | undefined

      const mw: Middleware = {
        async onRequest(ctx, next) {
          captured = {
            method: ctx.method,
            hasNext: typeof next === 'function',
            hasContext: ctx.mcpContext !== undefined,
          }
          return next()
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'ping', arguments: {} })
        expect(captured).toEqual({ method: 'tools/call', hasNext: true, hasContext: true })
      } finally {
        await close()
      }
    })

    it('values set via ctx.setState() by middleware are available in downstream tool handlers', async () => {
      const mcp = new FastMCP({ name: 'test' })

      mcp.tool({ name: 'read', description: 'read' }, () => {
        const ctx = mcp.getContext()
        return ctx.getState('injected') as string
      })

      const mw: Middleware = {
        async onRequest(ctx, next) {
          ctx.mcpContext.setState('injected', 'from-middleware')
          return next()
        },
      }
      mcp.use(mw)

      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'read', arguments: {} })
        expect((result as { content: { type: string; text: string }[] }).content[0]).toMatchObject({ type: 'text', text: 'from-middleware' })
      } finally {
        await close()
      }
    })
  })
})
