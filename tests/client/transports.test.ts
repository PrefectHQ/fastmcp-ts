import { describe, it, expect } from 'vitest'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import { BearerAuth, OAuth } from 'fastmcp-ts/client'
import { StdioTransport, resolveTransport } from '../../src/client/transports.js'

describe('resolveTransport', () => {
  describe('URL string inference', () => {
    it('HTTP URL → StreamableHTTPClientTransport', () => {
      const { transport } = resolveTransport('http://localhost:3000/mcp')
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('HTTPS URL → StreamableHTTPClientTransport', () => {
      const { transport } = resolveTransport('https://api.example.com/mcp')
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('/sse path segment → SSEClientTransport', () => {
      const { transport } = resolveTransport('http://localhost:3000/sse')
      expect(transport).toBeInstanceOf(SSEClientTransport)
    })

    it('/sse/ path prefix → SSEClientTransport', () => {
      const { transport } = resolveTransport('http://localhost:3000/sse/messages')
      expect(transport).toBeInstanceOf(SSEClientTransport)
    })

    it('non-SSE path stays Streamable HTTP', () => {
      const { transport } = resolveTransport('http://localhost:3000/api/mcp')
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('throws on an invalid URL string', () => {
      expect(() => resolveTransport('not-a-url')).toThrow()
    })
  })

  describe('StdioTransport config', () => {
    it('produces a StdioClientTransport', () => {
      const { transport } = resolveTransport(new StdioTransport('node', ['server.js']))
      expect(transport).toBeInstanceOf(StdioClientTransport)
    })

    it('passes command and args through', () => {
      const { transport } = resolveTransport(
        new StdioTransport('python', ['-m', 'myserver']),
      )
      expect(transport).toBeInstanceOf(StdioClientTransport)
    })
  })

  describe('pass-through SDK Transport', () => {
    it('returns the transport unchanged', () => {
      const [, clientSide] = InMemoryTransport.createLinkedPair()
      const { transport } = resolveTransport(clientSide)
      expect(transport).toBe(clientSide)
    })
  })

  describe('McpConfig object', () => {
    it('URL entry → StreamableHTTPClientTransport', () => {
      const { transport } = resolveTransport({
        mcpServers: { myServer: { url: 'http://localhost:3000/mcp' } },
      })
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('SSE URL entry → SSEClientTransport', () => {
      const { transport } = resolveTransport({
        mcpServers: { myServer: { url: 'http://localhost:3000/sse' } },
      })
      expect(transport).toBeInstanceOf(SSEClientTransport)
    })

    it('command entry → StdioClientTransport', () => {
      const { transport } = resolveTransport({
        mcpServers: { myServer: { command: 'node', args: ['server.js'] } },
      })
      expect(transport).toBeInstanceOf(StdioClientTransport)
    })

    it('uses the first entry when multiple servers are defined', () => {
      const { transport } = resolveTransport({
        mcpServers: {
          first: { url: 'http://localhost:3000/mcp' },
          second: { command: 'node', args: ['server.js'] },
        },
      })
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('throws when mcpServers is empty', () => {
      expect(() => resolveTransport({ mcpServers: {} })).toThrow('empty')
    })
  })

  describe('in-process server (McpServerLike)', () => {
    it('returns an InMemoryTransport', () => {
      const fakeServer = {
        connect: async () => {},
      }
      const { transport } = resolveTransport(fakeServer)
      expect(transport).toBeInstanceOf(InMemoryTransport)
    })

    it('provides a beforeConnect hook that calls server.connect', async () => {
      const calls: unknown[] = []
      const fakeServer = {
        connect: async (t: unknown) => { calls.push(t) },
      }
      const { transport, beforeConnect } = resolveTransport(fakeServer)
      expect(beforeConnect).toBeDefined()
      await beforeConnect!()
      expect(calls).toHaveLength(1)
      // The server side got the paired InMemoryTransport, client side is returned
      expect(transport).toBeInstanceOf(InMemoryTransport)
      expect(calls[0]).toBeInstanceOf(InMemoryTransport)
      expect(calls[0]).not.toBe(transport)
    })
  })

  describe('auth injection', () => {
    it('BearerAuth is accepted without throwing', () => {
      const auth = new BearerAuth('tok')
      expect(() => resolveTransport('http://localhost/mcp', auth)).not.toThrow()
    })

    it('OAuth is accepted without throwing', () => {
      const auth = new OAuth({ onRedirect: () => {} })
      expect(() => resolveTransport('http://localhost/mcp', auth)).not.toThrow()
    })
  })

  describe('error cases', () => {
    it('throws on unrecognized input', () => {
      expect(() => resolveTransport(42 as never)).toThrow()
    })
  })
})
