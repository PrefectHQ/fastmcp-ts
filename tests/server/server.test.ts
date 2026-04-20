import { describe, it, expect, afterEach } from 'vitest'
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
    it.todo('runs over stdio')
    it.todo('runs over HTTP (Streamable HTTP)')
    it.todo('runs over SSE')
  })
})
