import { describe, it, expect, afterEach } from 'vitest'
import { Server, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from 'fastmcp-ts/client'

/** Build a minimal SDK Server that advertises resource subscription support. */
function makeSubscriptionServer() {
  const server = new Server(
    { name: 'test', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true } } },
  )
  server.setRequestHandler('resources/subscribe', async () => ({}))
  server.setRequestHandler('resources/unsubscribe', async () => ({}))
  return server
}

async function withSubscriptionServer(
  fn: (client: Client, server: Server) => Promise<void>,
) {
  const server = makeSubscriptionServer()
  const client = await Client.connect(server)
  try {
    await fn(client, server)
  } finally {
    await client.close()
  }
}

/** Yield to the event loop to let in-memory transport deliver the notification. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

describe('Client — Resource Subscriptions', () => {
  describe('subscribeResource()', () => {
    it('calls the handler when the server sends a resource update', async () => {
      await withSubscriptionServer(async (client, server) => {
        const updates: string[] = []
        await client.subscribeResource('file:///data.txt', (uri) => { updates.push(uri) })
        await server.sendResourceUpdated({ uri: 'file:///data.txt' })
        await tick()
        expect(updates).toEqual(['file:///data.txt'])
      })
    })

    it('does not call the handler for a different URI', async () => {
      await withSubscriptionServer(async (client, server) => {
        const updates: string[] = []
        await client.subscribeResource('file:///watched.txt', (uri) => { updates.push(uri) })
        await server.sendResourceUpdated({ uri: 'file:///other.txt' })
        await tick()
        expect(updates).toHaveLength(0)
      })
    })

    it('routes updates to the correct handler when multiple subscriptions are active', async () => {
      await withSubscriptionServer(async (client, server) => {
        const aUpdates: string[] = []
        const bUpdates: string[] = []
        await client.subscribeResource('file:///a.txt', (uri) => { aUpdates.push(uri) })
        await client.subscribeResource('file:///b.txt', (uri) => { bUpdates.push(uri) })
        await server.sendResourceUpdated({ uri: 'file:///b.txt' })
        await tick()
        expect(aUpdates).toHaveLength(0)
        expect(bUpdates).toEqual(['file:///b.txt'])
      })
    })

    it('calls the handler multiple times for repeated updates', async () => {
      await withSubscriptionServer(async (client, server) => {
        const updates: string[] = []
        await client.subscribeResource('file:///counter.txt', (uri) => { updates.push(uri) })
        await server.sendResourceUpdated({ uri: 'file:///counter.txt' })
        await server.sendResourceUpdated({ uri: 'file:///counter.txt' })
        await tick()
        expect(updates).toHaveLength(2)
      })
    })
  })

  describe('unsubscribeResource()', () => {
    it('stops calling the handler after unsubscribing', async () => {
      await withSubscriptionServer(async (client, server) => {
        const updates: string[] = []
        await client.subscribeResource('file:///live.txt', (uri) => { updates.push(uri) })
        await server.sendResourceUpdated({ uri: 'file:///live.txt' })
        await tick()
        expect(updates).toHaveLength(1)

        await client.unsubscribeResource('file:///live.txt')
        await server.sendResourceUpdated({ uri: 'file:///live.txt' })
        await tick()
        expect(updates).toHaveLength(1)
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Modern era (2026-07-28): resources/subscribe and resources/unsubscribe are
// legacy-only RPCs, physically absent from the modern method registry —
// subscribeResource()/unsubscribeResource() must route through a
// subscriptions/listen stream instead. InMemoryTransport pairs (used above) are
// 2025-era only, so this needs a real HTTP server built directly on
// createMcpHandler (FastMCP does not implement server-side resource
// subscriptions at all — see tests/server/resources.test.ts's it.todo markers —
// so this exercises the client against a hand-built modern-only server, the
// same way the legacy tests above exercise it against a hand-built Server).
// ---------------------------------------------------------------------------

describe('Client — Resource Subscriptions (modern era, 2026-07-28)', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  async function withModernSubscriptionServer(
    fn: (client: Client, notifyResourceUpdated: (uri: string) => void) => Promise<void>,
  ): Promise<void> {
    const handler = createMcpHandler(
      () =>
        new Server(
          { name: 'test', version: '1.0.0' },
          // resources.subscribe: true is what the modern listen router checks before
          // honoring a resourceSubscriptions filter entry (SubscriptionFilter's
          // resourceSubscriptions is silently dropped from the honored filter
          // otherwise) — the same capability flag the legacy resources/subscribe RPC
          // path is gated on, just consulted by a different mechanism now.
          { capabilities: { resources: { subscribe: true } } },
        ),
      { legacy: 'reject' },
    )
    const nodeHandler = toNodeHandler(handler)
    const httpServer = createServer((req, res) => {
      void nodeHandler(req, res)
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as AddressInfo).port

    const client = new Client(`http://127.0.0.1:${port}/mcp`, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect()
    cleanup = async () => {
      await client.close()
      await handler.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }

    try {
      expect(client.getProtocolEra()).toBe('modern')
      await fn(client, (uri) => handler.notify.resourceUpdated(uri))
    } finally {
      await cleanup()
      cleanup = undefined
    }
  }

  it('calls the handler when the server publishes a resource update over subscriptions/listen', async () => {
    await withModernSubscriptionServer(async (client, notifyResourceUpdated) => {
      const updates: string[] = []
      await client.subscribeResource('file:///data.txt', (uri) => { updates.push(uri) })
      notifyResourceUpdated('file:///data.txt')
      await tick()
      expect(updates).toEqual(['file:///data.txt'])
    })
  })

  it('does not call the handler for a URI it never subscribed to', async () => {
    await withModernSubscriptionServer(async (client, notifyResourceUpdated) => {
      const updates: string[] = []
      await client.subscribeResource('file:///watched.txt', (uri) => { updates.push(uri) })
      notifyResourceUpdated('file:///other.txt')
      await tick()
      expect(updates).toHaveLength(0)
    })
  })

  it('routes updates to the correct handler when multiple subscriptions are active', async () => {
    await withModernSubscriptionServer(async (client, notifyResourceUpdated) => {
      const aUpdates: string[] = []
      const bUpdates: string[] = []
      await client.subscribeResource('file:///a.txt', (uri) => { aUpdates.push(uri) })
      await client.subscribeResource('file:///b.txt', (uri) => { bUpdates.push(uri) })
      notifyResourceUpdated('file:///b.txt')
      await tick()
      expect(aUpdates).toHaveLength(0)
      expect(bUpdates).toEqual(['file:///b.txt'])
    })
  })

  it('stops calling the handler after unsubscribing', async () => {
    await withModernSubscriptionServer(async (client, notifyResourceUpdated) => {
      const updates: string[] = []
      await client.subscribeResource('file:///live.txt', (uri) => { updates.push(uri) })
      notifyResourceUpdated('file:///live.txt')
      await tick()
      expect(updates).toHaveLength(1)

      await client.unsubscribeResource('file:///live.txt')
      notifyResourceUpdated('file:///live.txt')
      await tick()
      expect(updates).toHaveLength(1)
    })
  })
})
