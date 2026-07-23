import { describe, it, expect, vi } from 'vitest'
import type { ClientCapabilities } from '@modelcontextprotocol/client'
import { FastMCP } from 'fastmcp-ts/server'
import { connectEra, describeEachEra, withLogLevel, type EraCombo } from '../helpers/eras'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Connect over the current era combo, optionally advertising client capabilities. */
function capable(combo: EraCombo, mcp: FastMCP, capabilities: ClientCapabilities = {}) {
  return connectEra(mcp, combo, { capabilities })
}

// ---------------------------------------------------------------------------
// Access — every case runs across all four transport/era combos, with era-gated
// context features (sampling / elicitation / roots / session state / logging)
// forked to their legacy vs modern behavior.
// ---------------------------------------------------------------------------

describeEachEra('Server — Context', (combo) => {
  describe('access', () => {
    it('a tool handler can access the current request context via mcp.getContext()', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let ctxAuth: unknown = 'not-set'
      mcp.tool({ name: 'check', description: 'test' }, () => {
        ctxAuth = mcp.getContext().auth
        return 'ok'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        await client.callTool({ name: 'check', arguments: {} })
        expect(ctxAuth).toBeUndefined()
      } finally {
        await close()
      }
    })

    it('resource and prompt handlers can also access context via mcp.getContext()', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let resourceCtxSet = false
      let promptCtxSet = false

      mcp.resource({ uri: 'ctx://test' }, () => {
        resourceCtxSet = mcp.getContext() !== undefined
        return 'ok'
      })
      mcp.prompt({ name: 'ctxPrompt', description: 'test' }, () => {
        promptCtxSet = mcp.getContext() !== undefined
        return 'ok'
      })

      const { client, close } = await connectEra(mcp, combo)
      try {
        await client.readResource({ uri: 'ctx://test' })
        await client.getPrompt({ name: 'ctxPrompt', arguments: {} })
        expect(resourceCtxSet).toBe(true)
        expect(promptCtxSet).toBe(true)
      } finally {
        await close()
      }
    })

    it('getContext() throws when called outside a request handler', () => {
      const mcp = new FastMCP({ name: 'test' })
      expect(() => mcp.getContext()).toThrow()
    })

    it('context.requestId reflects the current MCP request id', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let capturedId: string | undefined
      mcp.tool({ name: 'getId', description: 'test' }, () => {
        capturedId = mcp.getContext().requestId
        return 'ok'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        await client.callTool({ name: 'getId', arguments: {} })
        expect(capturedId).toBeDefined()
        expect(typeof capturedId).toBe('string')
      } finally {
        await close()
      }
    })

    // NOTE: the old "createContext with undefined requestId" regression test (guarding
    // against String(undefined) → the literal string "undefined") no longer applies.
    // createContext's requestId now comes from the SDK's own ServerContext.mcpReq.id,
    // which is always present by type (RequestId = string | number, never undefined) —
    // the scenario that test guarded against can no longer be constructed.
  })

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  describe('logging', () => {
    it('log messages emitted via context are forwarded to the connected client', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'logger', description: 'test' }, async () => {
        await mcp.getContext().info('hello from tool')
        return 'done'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const received: unknown[] = []
        client.setNotificationHandler('notifications/message', (n) => {
          received.push(n.params)
        })
        // Legacy forwards log notifications at the default level with no opt-in. Modern
        // has no push-notification channel for logs and no logging/setLevel RPC: the
        // desired level is threaded per request through the reserved _meta logLevel key
        // (absent = suppressed), and the messages ride the request's own response.
        await client.callTool(withLogLevel(combo, { name: 'logger', arguments: {} }))
        expect(received).toHaveLength(1)
        expect((received[0] as Record<string, unknown>).data).toBe('hello from tool')
        expect((received[0] as Record<string, unknown>).level).toBe('info')
      } finally {
        await close()
      }
    })

    it('all severity levels (debug through emergency) are transmitted correctly', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const levels = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const
      mcp.tool({ name: 'allLevels', description: 'test' }, async () => {
        const ctx = mcp.getContext()
        await ctx.debug('msg')
        await ctx.info('msg')
        await ctx.notice('msg')
        await ctx.warning('msg')
        await ctx.error('msg')
        await ctx.critical('msg')
        await ctx.alert('msg')
        await ctx.emergency('msg')
        return 'done'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const received: string[] = []
        client.setNotificationHandler('notifications/message', (n) => {
          received.push(n.params.level)
        })
        // Modern threads the minimum level via _meta ('debug' passes everything through).
        await client.callTool(withLogLevel(combo, { name: 'allLevels', arguments: {} }, 'debug'))
        expect(received).toEqual([...levels])
      } finally {
        await close()
      }
    })

    it('the client filters log messages below the requested level', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'logger', description: 'test' }, async () => {
        const ctx = mcp.getContext()
        await ctx.debug('low')
        await ctx.error('high')
        return 'done'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const received: string[] = []
        client.setNotificationHandler('notifications/message', (n) => {
          received.push(n.params.level)
        })
        if (combo.era === 'legacy') {
          // Legacy: filtering is set out-of-band via the logging/setLevel RPC.
          await client.setLoggingLevel('warning')
          await client.callTool({ name: 'logger', arguments: {} })
        } else {
          // Modern: logging/setLevel is not a wire method on 2026-07-28 — it rejects.
          // The per-request minimum level is threaded through _meta instead.
          await expect(client.setLoggingLevel('warning')).rejects.toThrow()
          await client.callTool(withLogLevel(combo, { name: 'logger', arguments: {} }, 'warning'))
        }
        expect(received).toEqual(['error']) // 'debug' (< warning) filtered out; 'error' kept
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Progress reporting
  // ---------------------------------------------------------------------------

  describe('progress reporting', () => {
    it('progress notifications are sent when the request includes a progressToken in _meta', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'progressor', description: 'test' }, async () => {
        await mcp.getContext().reportProgress(50, 100, 'halfway')
        return 'done'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const received: unknown[] = []
        client.setNotificationHandler('notifications/progress', (n) => {
          received.push(n.params)
        })
        await client.callTool(
          { name: 'progressor', arguments: {} },
          // onprogress causes the SDK to inject a progressToken into _meta
          { onprogress: () => {} },
        )
        expect(received).toHaveLength(1)
        const p = received[0] as Record<string, unknown>
        expect(typeof p.progressToken).toBe('number') // SDK uses numeric tokens
        expect(p.progress).toBe(50)
        expect(p.total).toBe(100)
        expect(p.message).toBe('halfway')
      } finally {
        await close()
      }
    })

    it('reportProgress is a no-op when no progressToken was provided in the request', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'noToken', description: 'test' }, async () => {
        // No token in request — should not throw or send anything
        await mcp.getContext().reportProgress(50, 100)
        return 'done'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        const received: unknown[] = []
        client.setNotificationHandler('notifications/progress', (n) => {
          received.push(n.params)
        })
        await client.callTool({ name: 'noToken', arguments: {} })
        expect(received).toHaveLength(0)
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // LLM sampling
  // ---------------------------------------------------------------------------

  describe('LLM sampling', () => {
    it('a sampling request via context is forwarded to the client for fulfillment', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'sampler', description: 'test' }, async () => {
        await mcp.getContext().sample({
          messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }],
        })
        return 'done'
      })
      const { client, close } = await capable(combo, mcp, { sampling: {} })
      try {
        const samplingRequests: unknown[] = []
        client.setRequestHandler('sampling/createMessage', (req) => {
          samplingRequests.push(req.params)
          return {
            role: 'assistant',
            content: { type: 'text', text: 'Hello!' },
            model: 'test-model',
            stopReason: 'endTurn',
          }
        })
        if (combo.era === 'legacy') {
          await client.callTool({ name: 'sampler', arguments: {} })
          expect(samplingRequests).toHaveLength(1)
          const req = samplingRequests[0] as Record<string, unknown>
          expect((req.messages as unknown[])).toHaveLength(1)
        } else {
          // Modern (SEP-2577): sampling is not a server→client request on 2026-07-28.
          // ctx.sample() throws the SDK era gate (which names inputRequired) on BOTH
          // modern transports — fastmcp runs the era gate ahead of its own capability
          // guard on modern requests, so stdio-modern no longer misattributes the throw
          // to a missing client capability (task-9 Req 2, was report finding #2). The
          // handler lets it propagate, so tools/call is isError and the client-side
          // sampling handler is never reached.
          const result = await client.callTool({ name: 'sampler', arguments: {} })
          expect(result.isError).toBe(true)
          expect(((result.content as unknown[])[0] as Record<string, unknown>).text).toContain('inputRequired')
          expect(samplingRequests).toHaveLength(0)
        }
      } finally {
        await close()
      }
    })

    it('the client response is returned to the tool as the sampling result', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let samplingResult: unknown
      mcp.tool({ name: 'sampler', description: 'test' }, async () => {
        samplingResult = await mcp.getContext().sample({
          messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }],
        })
        return 'done'
      })
      const { client, close } = await capable(combo, mcp, { sampling: {} })
      try {
        client.setRequestHandler('sampling/createMessage', () => ({
          role: 'assistant',
          content: { type: 'text', text: 'Hello from LLM!' },
          model: 'test-model',
          stopReason: 'endTurn',
        }))
        if (combo.era === 'legacy') {
          await client.callTool({ name: 'sampler', arguments: {} })
          expect((samplingResult as Record<string, unknown>).model).toBe('test-model')
          expect(
            ((samplingResult as Record<string, unknown>).content as Record<string, unknown>).text,
          ).toBe('Hello from LLM!')
        } else {
          // Modern: ctx.sample() throws before samplingResult is ever assigned.
          const result = await client.callTool({ name: 'sampler', arguments: {} })
          expect(result.isError).toBe(true)
          expect(samplingResult).toBeUndefined()
        }
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // User elicitation
  // ---------------------------------------------------------------------------

  describe('user elicitation', () => {
    it('an elicitation request via context is forwarded to the client', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'elicitor', description: 'test' }, async () => {
        await mcp.getContext().elicit('Which env?', {
          type: 'object',
          properties: { env: { type: 'string', description: 'Target environment' } },
          required: ['env'],
        })
        return 'done'
      })
      const { client, close } = await capable(combo, mcp, { elicitation: { form: {} } })
      try {
        const elicitRequests: unknown[] = []
        client.setRequestHandler('elicitation/create', (req) => {
          elicitRequests.push(req.params)
          return { action: 'accept', content: { env: 'staging' } }
        })
        if (combo.era === 'legacy') {
          await client.callTool({ name: 'elicitor', arguments: {} })
          expect(elicitRequests).toHaveLength(1)
          expect((elicitRequests[0] as Record<string, unknown>).message).toBe('Which env?')
        } else {
          // Modern (SEP-2577): elicitation is not a server→client request. ctx.elicit()
          // throws the SDK era gate (which names inputRequired) on BOTH modern transports
          // — the era gate runs ahead of fastmcp's capability guard on modern requests, so
          // stdio-modern no longer misattributes the throw to a missing capability (task-9
          // Req 2, was report finding #2). tools/call is isError; the client handler is
          // never reached.
          const result = await client.callTool({ name: 'elicitor', arguments: {} })
          expect(result.isError).toBe(true)
          expect(((result.content as unknown[])[0] as Record<string, unknown>).text).toContain('inputRequired')
          expect(elicitRequests).toHaveLength(0)
        }
      } finally {
        await close()
      }
    })

    it('the client response (accept / decline / cancel) is returned to the tool', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let elicitResult: unknown
      mcp.tool({ name: 'elicitor', description: 'test' }, async () => {
        elicitResult = await mcp.getContext().elicit('Confirm?', {
          type: 'object',
          properties: { confirmed: { type: 'boolean' } },
        })
        return 'done'
      })
      const { client, close } = await capable(combo, mcp, { elicitation: { form: {} } })
      try {
        client.setRequestHandler('elicitation/create', () => ({
          action: 'decline',
        }))
        if (combo.era === 'legacy') {
          await client.callTool({ name: 'elicitor', arguments: {} })
          expect((elicitResult as Record<string, unknown>).action).toBe('decline')
        } else {
          // Modern: ctx.elicit() throws before elicitResult is assigned.
          const result = await client.callTool({ name: 'elicitor', arguments: {} })
          expect(result.isError).toBe(true)
          expect(elicitResult).toBeUndefined()
        }
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Roots
  // ---------------------------------------------------------------------------

  describe('roots', () => {
    it('context.listRoots() returns the roots declared by the client', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let roots: unknown
      mcp.tool({ name: 'getRoots', description: 'test' }, async () => {
        roots = await mcp.getContext().listRoots()
        return 'done'
      })
      const { client, close } = await capable(combo, mcp, { roots: { listChanged: false } })
      try {
        client.setRequestHandler('roots/list', () => ({
          roots: [
            { uri: 'file:///home/user/project', name: 'My Project' },
            { uri: 'file:///home/user/docs' },
          ],
        }))
        if (combo.era === 'legacy') {
          await client.callTool({ name: 'getRoots', arguments: {} })
          expect(roots).toHaveLength(2)
          expect((roots as unknown[])[0]).toMatchObject({ uri: 'file:///home/user/project', name: 'My Project' })
        } else {
          // Modern (SEP-2577): roots is not a server→client request. ctx.listRoots()
          // throws the SDK era gate (which names inputRequired) on BOTH modern transports
          // — the era gate runs ahead of fastmcp's capability guard on modern requests, so
          // stdio-modern no longer misattributes the throw to a missing capability (task-9
          // Req 2, was report finding #2).
          const result = await client.callTool({ name: 'getRoots', arguments: {} })
          expect(result.isError).toBe(true)
          expect(((result.content as unknown[])[0] as Record<string, unknown>).text).toContain('inputRequired')
          expect(roots).toBeUndefined()
        }
      } finally {
        await close()
      }
    })

    it('context.listRoots() returns an empty array when the client declares no roots', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let roots: unknown
      mcp.tool({ name: 'getRoots', description: 'test' }, async () => {
        roots = await mcp.getContext().listRoots()
        return 'done'
      })
      const { client, close } = await capable(combo, mcp, { roots: { listChanged: false } })
      try {
        client.setRequestHandler('roots/list', () => ({ roots: [] }))
        if (combo.era === 'legacy') {
          await client.callTool({ name: 'getRoots', arguments: {} })
          expect(roots).toEqual([])
        } else {
          // Modern: ctx.listRoots() throws before roots is assigned.
          const result = await client.callTool({ name: 'getRoots', arguments: {} })
          expect(result.isError).toBe(true)
          expect(roots).toBeUndefined()
        }
      } finally {
        await close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  describe('session state', () => {
    it('values stored in session state persist across requests within the same session', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'setState', description: 'test' }, () => {
        mcp.getContext().setState('counter', 42)
        return 'set'
      })
      mcp.tool({ name: 'getState', description: 'test' }, () => {
        return String(mcp.getContext().getState('counter'))
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        if (combo.sessionStatePersists) {
          await client.callTool({ name: 'setState', arguments: {} })
          const result = await client.callTool({ name: 'getState', arguments: {} })
          const content = (result.content as unknown[])[0] as Record<string, unknown>
          expect(content.text).toBe('42')
        } else {
          // http-modern: each modern HTTP request is dispatched statelessly with a fresh
          // per-request state Map. Plan §3: on modern HTTP, setState/getState throw a
          // pointed error naming ctx.requestState()/ctx.mintRequestState() rather than
          // silently dropping the write. The tool handler lets the throw propagate, so
          // tools/call is isError. (task-9 Req 1; the request-scoped state story is
          // ctx.requestState()/mintRequestState(), not session state.)
          const setResult = await client.callTool({ name: 'setState', arguments: {} })
          expect(setResult.isError).toBe(true)
          const setText = ((setResult.content as unknown[])[0] as Record<string, unknown>).text as string
          expect(setText).toContain('ctx.requestState()')
          const getResult = await client.callTool({ name: 'getState', arguments: {} })
          expect(getResult.isError).toBe(true)
          const getText = ((getResult.content as unknown[])[0] as Record<string, unknown>).text as string
          expect(getText).toContain('ctx.requestState()')
        }
      } finally {
        await close()
      }
    })

    it('deleteState throws the same pointed error on modern HTTP, and is a plain delete elsewhere', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'deleteState', description: 'test' }, () => {
        mcp.getContext().deleteState('counter')
        return 'deleted'
      })
      const { client, close } = await connectEra(mcp, combo)
      try {
        if (combo.sessionStatePersists) {
          // stdio (both eras) + legacy HTTP: deleteState mutates the session map — no throw.
          const result = await client.callTool({ name: 'deleteState', arguments: {} })
          expect(result.isError).toBeFalsy()
          const content = (result.content as unknown[])[0] as Record<string, unknown>
          expect(content.text).toBe('deleted')
        } else {
          // http-modern: symmetric with setState/getState — deleteState throws the
          // pointed error naming ctx.requestState()/mintRequestState() rather than
          // silently no-op'ing against a fresh per-request state map. (task-10 Req 2)
          const result = await client.callTool({ name: 'deleteState', arguments: {} })
          expect(result.isError).toBe(true)
          const text = ((result.content as unknown[])[0] as Record<string, unknown>).text as string
          expect(text).toContain('ctx.requestState()')
        }
      } finally {
        await close()
      }
    })

    it('session state is isolated between different client sessions', async (ctx) => {
      // Genuinely inapplicable on stdio: a stdio connection is a single pinned server
      // with ONE shared session-state map, so "two isolated client sessions" cannot be
      // represented over one pipe. Covered by the two HTTP combos below.
      if (combo.transport === 'stdio') {
        ctx.skip()
        return
      }

      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'setState', description: 'test' }, () => {
        mcp.getContext().setState('val', 'session-a')
        return 'set'
      })
      mcp.tool({ name: 'getState', description: 'test' }, () => {
        return String(mcp.getContext().getState('val') ?? 'empty')
      })

      await mcp.run({ transport: 'http', port: 0 })
      const addr = mcp.address!
      const host = addr.host === '0.0.0.0' ? '127.0.0.1' : addr.host

      const { Client: SdkClient, StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/client'
      )
      const versionNegotiation =
        combo.era === 'modern' ? { mode: { pin: '2026-07-28' as const } } : { mode: 'legacy' as const }

      const makeClient = async () => {
        const c = new SdkClient({ name: 'c', version: '0.0.0' }, { capabilities: {}, versionNegotiation })
        await c.connect(new StreamableHTTPClientTransport(new URL(`http://${host}:${addr.port}${addr.path}`)))
        return c
      }

      try {
        const clientA = await makeClient()
        const clientB = await makeClient()

        if (combo.era === 'legacy') {
          // Legacy sessionful HTTP: each client is its own session with an isolated map.
          await clientA.callTool({ name: 'setState', arguments: {} })
          const resultA = await clientA.callTool({ name: 'getState', arguments: {} })
          const textA = ((resultA.content as unknown[])[0] as Record<string, unknown>).text
          const resultB = await clientB.callTool({ name: 'getState', arguments: {} })
          const textB = ((resultB.content as unknown[])[0] as Record<string, unknown>).text
          expect(textA).toBe('session-a')
          expect(textB).toBe('empty')
        } else {
          // Modern HTTP is stateless per request. Plan §3: setState/getState throw a
          // pointed error naming ctx.requestState()/ctx.mintRequestState(). Both handlers
          // let it propagate, so tools/call is isError. Cross-client isolation holds
          // trivially — no session state is retained. (task-9 Req 1)
          const setA = await clientA.callTool({ name: 'setState', arguments: {} })
          expect(setA.isError).toBe(true)
          expect(((setA.content as unknown[])[0] as Record<string, unknown>).text).toContain('ctx.requestState()')
          const getA = await clientA.callTool({ name: 'getState', arguments: {} })
          expect(getA.isError).toBe(true)
          const getB = await clientB.callTool({ name: 'getState', arguments: {} })
          expect(getB.isError).toBe(true)
        }

        await clientA.close()
        await clientB.close()
      } finally {
        await mcp.close()
      }
    })
  })
})
