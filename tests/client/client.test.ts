import { describe, it, expect } from 'vitest'
import { z } from 'zod/v4'
import { FastMCP } from 'fastmcp-ts/server'
import { Client } from 'fastmcp-ts/client'

function makeServer(name = 'test') {
  const mcp = new FastMCP({ name, version: '1.0.0' })
  mcp.tool({ name: 'echo', input: z.object({ msg: z.string() }) }, ({ msg }) => msg)
  return mcp
}

describe('Client', () => {
  describe('lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const client = new Client(makeServer())
      expect(client.isConnected()).toBe(false)
    })

    it('isConnected() returns true after connect', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      expect(client.isConnected()).toBe(true)
    })

    it('isConnected() returns false after close()', async () => {
      const client = await Client.connect(makeServer())
      await client.close()
      expect(client.isConnected()).toBe(false)
    })

    it('close() is idempotent when called multiple times', async () => {
      const client = await Client.connect(makeServer())
      await client.close()
      await expect(client.close()).resolves.toBeUndefined()
      expect(client.isConnected()).toBe(false)
    })

    it('reentrant connect() ref-counts — requires matching closes', async () => {
      const client = new Client(makeServer())
      await client.connect()
      await client.connect()
      expect(client.isConnected()).toBe(true)
      await client.close() // refCount → 1
      expect(client.isConnected()).toBe(true)
      await client.close() // refCount → 0, actually closes
      expect(client.isConnected()).toBe(false)
    })

    it('ping() resolves when connected', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      await expect(client.ping()).resolves.toBe(true)
    })

    it('throws when calling methods without connecting', async () => {
      const client = new Client(makeServer())
      await expect(client.listTools()).rejects.toThrow('not connected')
    })

    it('static Client.connect() returns a ready-to-use client', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      expect(client.isConnected()).toBe(true)
      const tools = await client.listTools()
      expect(tools).toBeInstanceOf(Array)
    })

    it('supports `await using` for automatic cleanup', async () => {
      let connectedDuringBlock = false
      {
        await using client = await Client.connect(makeServer())
        connectedDuringBlock = client.isConnected()
      }
      expect(connectedDuringBlock).toBe(true)
    })
  })

  describe('autoInitialize', () => {
    it('auto-initializes on connect by default', async () => {
      const client = await Client.connect(makeServer())
      await using _ = client
      await expect(client.listTools()).resolves.toBeInstanceOf(Array)
    })

    it.todo('skips MCP handshake when autoInitialize is false')
  })

  describe('in-process transport', () => {
    it('connects directly to a FastMCP server instance', async () => {
      const mcp = new FastMCP({ name: 'direct', version: '1.0.0' })
      mcp.tool({ name: 'greet', input: z.object({ name: z.string() }) }, ({ name }) => `hello ${name}`)

      const client = await Client.connect(mcp)
      await using _ = client

      const result = await client.callTool('greet', { name: 'world' })
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello world' })
    })
  })
})
