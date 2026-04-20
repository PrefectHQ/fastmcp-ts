import { describe, it, expect } from 'vitest'
import { FastMCP } from 'fastmcp-ts/server'

describe('Server', () => {
  describe('instantiation', () => {
    it('creates a server with a name', () => {
      const mcp = new FastMCP({ name: 'test-server' })
      expect(mcp.name).toBe('test-server')
    })
    it.todo('accepts server-level configuration (strict validation, error masking, etc.)')
  })

  describe('transports', () => {
    it.todo('runs over stdio')
    it.todo('runs over HTTP (Streamable HTTP)')
    it.todo('runs over SSE')
  })
})
