import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CLIENT_CAPABILITIES_META_KEY,
  InMemoryTransport,
} from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { Server, createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { Client, MultiServerClient } from 'fastmcp-ts/client'
import type { ClientOptions } from 'fastmcp-ts/client'

const UI_EXTENSION = {
  extensions: {
    'io.modelcontextprotocol/ui': {
      mimeTypes: ['text/html;profile=mcp-app'],
    },
  },
}

async function connectLegacyServer(options?: ClientOptions) {
  const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = await Client.connect(clientTransport, {
    versionNegotiation: { mode: 'legacy' },
    ...options,
  })
  return { client, server }
}

describe('Client capabilities', () => {
  it('advertises a caller-supplied extension in legacy initialize capabilities', async () => {
    const { client, server } = await connectLegacyServer({ capabilities: UI_EXTENSION })
    try {
      expect(server.getClientCapabilities()?.extensions).toEqual(UI_EXTENSION.extensions)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('merges custom capabilities with roots, sampling, and elicitation', async () => {
    const { client, server } = await connectLegacyServer({
      capabilities: {
        ...UI_EXTENSION,
        sampling: { context: { customContext: true } },
        elicitation: { url: {} },
      },
      roots: ['file:///workspace'],
      handlers: {
        sampling: async () => ({
          role: 'assistant',
          content: { type: 'text', text: 'sampled' },
          model: 'test',
          stopReason: 'endTurn',
        }),
        elicitation: async () => ({ action: 'decline' }),
      },
    })

    try {
      expect(server.getClientCapabilities()).toMatchObject({
        extensions: UI_EXTENSION.extensions,
        roots: { listChanged: true },
        sampling: {
          context: { customContext: true },
          tools: {},
        },
        elicitation: { form: {}, url: {} },
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('advertises custom capabilities to every server in a multi-server client', async () => {
    const a = new Server({ name: 'a', version: '1.0.0' }, { capabilities: {} })
    const b = new Server({ name: 'b', version: '1.0.0' }, { capabilities: {} })
    const client = await MultiServerClient.connect(
      { mcpServers: { a, b } },
      {
        capabilities: UI_EXTENSION,
        versionNegotiation: { mode: 'legacy' },
      },
    )

    try {
      expect(a.getClientCapabilities()?.extensions).toEqual(UI_EXTENSION.extensions)
      expect(b.getClientCapabilities()?.extensions).toEqual(UI_EXTENSION.extensions)
    } finally {
      await client.close()
      await a.close()
      await b.close()
    }
  })

  it('keeps the existing empty capability advertisement without custom options', async () => {
    const { client, server } = await connectLegacyServer()
    try {
      expect(server.getClientCapabilities()).toEqual({})
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('Client capabilities on the modern wire', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  it('includes the extension in per-request client-capabilities metadata', async () => {
    const receivedCapabilities: unknown[] = []
    const server = new Server(
      { name: 'test', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler('tools/list', async (_request, ctx) => {
      const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } }).mcpReq
        ?.envelope
      receivedCapabilities.push(envelope?.[CLIENT_CAPABILITIES_META_KEY])
      return { tools: [] }
    })

    const handler = createMcpHandler(() => server, { legacy: 'reject' })
    const nodeHandler = toNodeHandler(handler)
    const httpServer = createServer((req, res) => {
      void nodeHandler(req, res)
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as AddressInfo).port

    const client = await Client.connect(`http://127.0.0.1:${port}/mcp`, {
      capabilities: UI_EXTENSION,
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    cleanup = async () => {
      await client.close()
      await handler.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }

    await client.listTools()
    expect(receivedCapabilities).toEqual([UI_EXTENSION])
  })
})
