import { describe, it, expect, vi } from 'vitest'
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from '@modelcontextprotocol/client'
import { FastMCP } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a test client that also advertises client-side capabilities. */
async function createCapableTestClient(
  mcp: FastMCP,
  capabilities: Record<string, unknown> = {},
) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverTransport)
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities },
  )
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await mcp.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe('Server — Context', () => {
  describe('access', () => {
    it('a tool handler can access the current request context via mcp.getContext()', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let ctxAuth: unknown = 'not-set'
      mcp.tool({ name: 'check', description: 'test' }, () => {
        ctxAuth = mcp.getContext().auth
        return 'ok'
      })
      const { client, close } = await createTestClient(mcp)
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

      const { client, close } = await createTestClient(mcp)
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
      const { client, close } = await createTestClient(mcp)
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
      const { client, close } = await createTestClient(mcp)
      try {
        const received: unknown[] = []
        client.setNotificationHandler('notifications/message', (n) => {
          received.push(n.params)
        })
        await client.callTool({ name: 'logger', arguments: {} })
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
      const { client, close } = await createTestClient(mcp)
      try {
        const received: string[] = []
        client.setNotificationHandler('notifications/message', (n) => {
          received.push(n.params.level)
        })
        await client.callTool({ name: 'allLevels', arguments: {} })
        expect(received).toEqual([...levels])
      } finally {
        await close()
      }
    })

    it('logging/setLevel from the client filters messages below the requested level', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'logger', description: 'test' }, async () => {
        const ctx = mcp.getContext()
        await ctx.debug('low')
        await ctx.error('high')
        return 'done'
      })
      const { client, close } = await createTestClient(mcp)
      try {
        // Ask server to only send warning and above
        await client.setLoggingLevel('warning')
        const received: string[] = []
        client.setNotificationHandler('notifications/message', (n) => {
          received.push(n.params.level)
        })
        await client.callTool({ name: 'logger', arguments: {} })
        expect(received).toEqual(['error'])
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
      const { client, close } = await createTestClient(mcp)
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
      const { client, close } = await createTestClient(mcp)
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
      const { client, close } = await createCapableTestClient(mcp, { sampling: {} })
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
        await client.callTool({ name: 'sampler', arguments: {} })
        expect(samplingRequests).toHaveLength(1)
        const req = samplingRequests[0] as Record<string, unknown>
        expect((req.messages as unknown[])).toHaveLength(1)
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
      const { client, close } = await createCapableTestClient(mcp, { sampling: {} })
      try {
        client.setRequestHandler('sampling/createMessage', () => ({
          role: 'assistant',
          content: { type: 'text', text: 'Hello from LLM!' },
          model: 'test-model',
          stopReason: 'endTurn',
        }))
        await client.callTool({ name: 'sampler', arguments: {} })
        expect((samplingResult as Record<string, unknown>).model).toBe('test-model')
        expect(
          ((samplingResult as Record<string, unknown>).content as Record<string, unknown>).text,
        ).toBe('Hello from LLM!')
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
      const { client, close } = await createCapableTestClient(mcp, {
        elicitation: { form: {} },
      })
      try {
        const elicitRequests: unknown[] = []
        client.setRequestHandler('elicitation/create', (req) => {
          elicitRequests.push(req.params)
          return { action: 'accept', content: { env: 'staging' } }
        })
        await client.callTool({ name: 'elicitor', arguments: {} })
        expect(elicitRequests).toHaveLength(1)
        expect((elicitRequests[0] as Record<string, unknown>).message).toBe('Which env?')
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
      const { client, close } = await createCapableTestClient(mcp, {
        elicitation: { form: {} },
      })
      try {
        client.setRequestHandler('elicitation/create', () => ({
          action: 'decline',
        }))
        await client.callTool({ name: 'elicitor', arguments: {} })
        expect((elicitResult as Record<string, unknown>).action).toBe('decline')
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
      const { client, close } = await createCapableTestClient(mcp, {
        roots: { listChanged: false },
      })
      try {
        client.setRequestHandler('roots/list', () => ({
          roots: [
            { uri: 'file:///home/user/project', name: 'My Project' },
            { uri: 'file:///home/user/docs' },
          ],
        }))
        await client.callTool({ name: 'getRoots', arguments: {} })
        expect(roots).toHaveLength(2)
        expect((roots as unknown[])[0]).toMatchObject({ uri: 'file:///home/user/project', name: 'My Project' })
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
      const { client, close } = await createCapableTestClient(mcp, {
        roots: { listChanged: false },
      })
      try {
        client.setRequestHandler('roots/list', () => ({ roots: [] }))
        await client.callTool({ name: 'getRoots', arguments: {} })
        expect(roots).toEqual([])
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
      const { client, close } = await createTestClient(mcp)
      try {
        await client.callTool({ name: 'setState', arguments: {} })
        const result = await client.callTool({ name: 'getState', arguments: {} })
        const content = (result.content as unknown[])[0] as Record<string, unknown>
        expect(content.text).toBe('42')
      } finally {
        await close()
      }
    })

    it('session state is isolated between different client sessions', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'setState', description: 'test' }, () => {
        mcp.getContext().setState('val', 'session-a')
        return 'set'
      })
      mcp.tool({ name: 'getState', description: 'test' }, () => {
        return String(mcp.getContext().getState('val') ?? 'empty')
      })

      // Use HTTP transport so sessions are isolated
      await mcp.run({ transport: 'http', port: 0 })
      const addr = mcp.address!

      const { Client: SdkClient } = await import('@modelcontextprotocol/client')
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/client'
      )

      const makeClient = async () => {
        const c = new SdkClient({ name: 'c', version: '0.0.0' }, { capabilities: {} })
        await c.connect(new StreamableHTTPClientTransport(new URL(`http://${addr.host === '0.0.0.0' ? '127.0.0.1' : addr.host}:${addr.port}${addr.path}`)))
        return c
      }

      try {
        const clientA = await makeClient()
        const clientB = await makeClient()

        // Session A sets the value
        await clientA.callTool({ name: 'setState', arguments: {} })

        // Session A reads it back — should see 'session-a'
        const resultA = await clientA.callTool({ name: 'getState', arguments: {} })
        const textA = ((resultA.content as unknown[])[0] as Record<string, unknown>).text
        expect(textA).toBe('session-a')

        // Session B reads — should see 'empty' (its own isolated state)
        const resultB = await clientB.callTool({ name: 'getState', arguments: {} })
        const textB = ((resultB.content as unknown[])[0] as Record<string, unknown>).text
        expect(textB).toBe('empty')

        await clientA.close()
        await clientB.close()
      } finally {
        await mcp.close()
      }
    })
  })
})
