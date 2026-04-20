import { describe, it, expect, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp'
import { FastMCP } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'

describe('Server', () => {
  describe('instantiation', () => {
    it('creates a server with a name', () => {
      const mcp = new FastMCP({ name: 'test-server' })
      expect(mcp.name).toBe('test-server')
    })
    it.todo('accepts server-level configuration (strict validation, error masking, etc.)')
  })

  describe('in-process connection', () => {
    let close: () => Promise<void>

    afterEach(async () => { await close?.() })

    it('accepts an in-process client connection', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      ;({ close } = await createTestClient(mcp))
    })
  })

  describe('transports', () => {
    let close: () => Promise<void>

    afterEach(async () => { await close?.() })

    it('runs over stdio', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      const stdin = new PassThrough()
      const stdout = new PassThrough()

      const responsePromise = new Promise<string>((resolve) => {
        stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      })

      await mcp.run({ transport: 'stdio', stdin, stdout })
      close = () => mcp.close()

      stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.0' },
          },
        }) + '\n',
      )

      const msg = JSON.parse(await responsePromise)
      expect(msg.result.serverInfo.name).toBe('test-server')
    })

    it('runs over HTTP (Streamable HTTP)', async () => {
      const mcp = new FastMCP({ name: 'test-server' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      close = () => mcp.close()

      const { port } = mcp.address!
      const client = new Client(
        { name: 'test-client', version: '0.0.0' },
        { capabilities: {} },
      )
      const clientTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      )
      await client.connect(clientTransport)
      await client.close()
    })
  })
})
