import { describe, it, expect } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server'
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types'
import { Client } from 'fastmcp-ts/client'

/** Build a minimal SDK Server that advertises resource subscription support. */
function makeSubscriptionServer() {
  const server = new Server(
    { name: 'test', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true } } },
  )
  server.setRequestHandler(SubscribeRequestSchema, async () => ({}))
  server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}))
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
