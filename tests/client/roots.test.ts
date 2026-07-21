import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Server } from '@modelcontextprotocol/server'
import { FastMCP } from 'fastmcp-ts/server'
import { Client } from 'fastmcp-ts/client'
import type { Root } from 'fastmcp-ts/client'

// ---------------------------------------------------------------------------
// Helper — connect a Client to a FastMCP server, run fn, then clean up.
// ---------------------------------------------------------------------------

async function withServer(
  setup: (mcp: FastMCP) => void,
  fn: (client: Client) => Promise<void>,
  clientOptions?: Parameters<typeof Client.connect>[1],
) {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  setup(mcp)
  const client = await Client.connect(mcp, clientOptions)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

// Helper: invoke context.listRoots() from within a tool and return the result.
function makeRootsServer() {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  let capturedRoots: Root[] = []
  mcp.tool({ name: 'getRoots', description: 'a tool' }, async () => {
    capturedRoots = await mcp.getContext().listRoots() as Root[]
    return 'done'
  })
  return { mcp, getRoots: () => capturedRoots }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Client — Roots', () => {
  describe('static roots', () => {
    it('a string[] is sent to the server when roots/list is requested', async () => {
      const { mcp, getRoots } = makeRootsServer()
      const client = await Client.connect(mcp, { roots: ['file:///home/user/project'] })
      try {
        await client.callTool('getRoots', {})
        expect(getRoots()).toHaveLength(1)
        expect(getRoots()[0]).toMatchObject({ uri: 'file:///home/user/project' })
      } finally {
        await client.close()
      }
    })

    it('Root objects with a name field are forwarded intact', async () => {
      const { mcp, getRoots } = makeRootsServer()
      const client = await Client.connect(mcp, {
        roots: [{ uri: 'file:///home/user/project', name: 'My Project' }],
      })
      try {
        await client.callTool('getRoots', {})
        expect(getRoots()[0]).toMatchObject({ uri: 'file:///home/user/project', name: 'My Project' })
      } finally {
        await client.close()
      }
    })

    it('advertises roots: { listChanged: true } in client capabilities', async () => {
      // The client sends its capabilities during the initialize handshake.
      // The server can inspect them via server.getClientCapabilities() after connect.
      // We set up a raw SDK server so we can read what the client actually sent.
      const server = new Server(
        { name: 'test', version: '1.0.0' },
        { capabilities: {} },
      )
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)

      const client = await Client.connect(clientTransport, { roots: ['file:///test'] })
      try {
        const caps = server.getClientCapabilities()
        expect(caps?.roots).toMatchObject({ listChanged: true })
      } finally {
        await client.close()
        await server.close()
      }
    })

    it('no roots option — roots key absent from advertised capabilities', async () => {
      const server = new Server(
        { name: 'test', version: '1.0.0' },
        { capabilities: {} },
      )
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)

      // Connect without roots option.
      const client = await Client.connect(clientTransport)
      try {
        const caps = server.getClientCapabilities()
        expect(caps?.roots).toBeUndefined()
      } finally {
        await client.close()
        await server.close()
      }
    })
  })

  describe('URI normalisation', () => {
    it('bare absolute path is prefixed with file://', async () => {
      const { mcp, getRoots } = makeRootsServer()
      const client = await Client.connect(mcp, { roots: ['/home/user/project'] })
      try {
        await client.callTool('getRoots', {})
        expect(getRoots()[0]?.uri).toBe('file:///home/user/project')
      } finally {
        await client.close()
      }
    })

    it('file:// URI is passed through unchanged', async () => {
      const { mcp, getRoots } = makeRootsServer()
      const client = await Client.connect(mcp, { roots: ['file:///already/correct'] })
      try {
        await client.callTool('getRoots', {})
        expect(getRoots()[0]?.uri).toBe('file:///already/correct')
      } finally {
        await client.close()
      }
    })

    it('relative path is resolved against cwd and prefixed with file://', async () => {
      const { mcp, getRoots } = makeRootsServer()
      const client = await Client.connect(mcp, { roots: ['./src'] })
      try {
        await client.callTool('getRoots', {})
        const expected = pathToFileURL(resolve('./src')).href
        expect(getRoots()[0]?.uri).toBe(expected)
      } finally {
        await client.close()
      }
    })
  })

  describe('dynamic roots', () => {
    it('async callback is invoked when the server requests roots', async () => {
      const { mcp, getRoots } = makeRootsServer()
      const callback = vi.fn().mockResolvedValue([{ uri: 'file:///dynamic/path' }])
      const client = await Client.connect(mcp, { roots: callback })
      try {
        await client.callTool('getRoots', {})
        expect(callback).toHaveBeenCalledOnce()
        expect(getRoots()[0]).toMatchObject({ uri: 'file:///dynamic/path' })
      } finally {
        await client.close()
      }
    })

    it('callback is invoked on each roots/list request — result is not cached', async () => {
      const { mcp, getRoots } = makeRootsServer()
      let call = 0
      const callback = vi.fn().mockImplementation(() => {
        call++
        return [{ uri: `file:///dynamic/${call}` }]
      })
      const client = await Client.connect(mcp, { roots: callback })
      try {
        await client.callTool('getRoots', {})
        expect(getRoots()[0]?.uri).toBe('file:///dynamic/1')

        await client.callTool('getRoots', {})
        expect(getRoots()[0]?.uri).toBe('file:///dynamic/2')

        expect(callback).toHaveBeenCalledTimes(2)
      } finally {
        await client.close()
      }
    })
  })

  describe('notifyRootsChanged()', () => {
    it('delivers a roots/list_changed notification to the connected server', async () => {
      let notified = false

      // Use a raw SDK Server so we can register a notification handler.
      const server = new Server(
        { name: 'test', version: '1.0.0' },
        { capabilities: {} },
      )
      server.setNotificationHandler('notifications/roots/list_changed', () => {
        notified = true
      })

      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)

      // Pass the SDK transport directly (pass-through path in resolveTransport).
      const client = await Client.connect(clientTransport, { roots: ['file:///test'] })
      try {
        await client.notifyRootsChanged()
        // InMemoryTransport delivers synchronously within the same microtask queue.
        await Promise.resolve()
        expect(notified).toBe(true)
      } finally {
        await client.close()
        await server.close()
      }
    })

    it('throws when the client is not connected', async () => {
      const client = new Client('http://localhost:9999', { roots: ['file:///test'] })
      await expect(client.notifyRootsChanged()).rejects.toThrow('not connected')
    })
  })
})
