import { describe, it, expect } from 'vitest'
import type { CompleteRequest } from "@modelcontextprotocol/server";
import { Server } from '@modelcontextprotocol/server'
import { Client } from 'fastmcp-ts/client'

function makeCompletionServer(
  handler: (req: CompleteRequest) => { values: string[]; total?: number; hasMore?: boolean },
) {
  const server = new Server(
    { name: 'test', version: '1.0.0' },
    { capabilities: { completions: {} } },
  )
  server.setRequestHandler('completion/complete', async (req) => ({
    completion: handler(req),
  }))
  return server
}

async function withCompletionServer(
  handler: (req: CompleteRequest) => { values: string[]; total?: number; hasMore?: boolean },
  fn: (client: Client) => Promise<void>,
) {
  const server = makeCompletionServer(handler)
  const client = await Client.connect(server)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

describe('Client — Argument Completion', () => {
  describe('complete() with ref/prompt', () => {
    it('returns the completion values from the server', async () => {
      await withCompletionServer(
        () => ({ values: ['option-a', 'option-b', 'option-c'] }),
        async (client) => {
          const result = await client.complete(
            { type: 'ref/prompt', name: 'my-prompt' },
            { name: 'style', value: 'opt' },
          )
          expect(result.values).toEqual(['option-a', 'option-b', 'option-c'])
        },
      )
    })

    it('forwards the ref and argument to the server', async () => {
      let captured: CompleteRequest | null = null
      await withCompletionServer(
        (req) => { captured = req; return { values: [] } },
        async (client) => {
          await client.complete(
            { type: 'ref/prompt', name: 'summarise' },
            { name: 'lang', value: 'fr' },
          )
          expect(captured!.params.ref).toEqual({ type: 'ref/prompt', name: 'summarise' })
          expect(captured!.params.argument).toEqual({ name: 'lang', value: 'fr' })
        },
      )
    })
  })

  describe('complete() with ref/resource', () => {
    it('returns the completion values for a resource URI ref', async () => {
      await withCompletionServer(
        () => ({ values: ['readme.md', 'changelog.md'] }),
        async (client) => {
          const result = await client.complete(
            { type: 'ref/resource', uri: 'file:///{name}' },
            { name: 'name', value: 'r' },
          )
          expect(result.values).toEqual(['readme.md', 'changelog.md'])
        },
      )
    })
  })

  describe('context', () => {
    it('forwards optional context arguments to the server', async () => {
      let captured: CompleteRequest | null = null
      await withCompletionServer(
        (req) => { captured = req; return { values: [] } },
        async (client) => {
          await client.complete(
            { type: 'ref/prompt', name: 'translate' },
            { name: 'target', value: 'sp' },
            { arguments: { source: 'en' } },
          )
          expect(captured!.params.context).toEqual({ arguments: { source: 'en' } })
        },
      )
    })

    it('omits context when not provided', async () => {
      let captured: CompleteRequest | null = null
      await withCompletionServer(
        (req) => { captured = req; return { values: [] } },
        async (client) => {
          await client.complete(
            { type: 'ref/prompt', name: 'translate' },
            { name: 'target', value: 'sp' },
          )
          expect(captured!.params.context).toBeUndefined()
        },
      )
    })
  })

  describe('pagination fields', () => {
    it('returns total and hasMore when the server provides them', async () => {
      await withCompletionServer(
        () => ({ values: ['a', 'b'], total: 10, hasMore: true }),
        async (client) => {
          const result = await client.complete(
            { type: 'ref/prompt', name: 'p' },
            { name: 'q', value: '' },
          )
          expect(result.total).toBe(10)
          expect(result.hasMore).toBe(true)
        },
      )
    })
  })
})
