import { describe, it, expect } from 'vitest'
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport, SSEClientTransport, InMemoryTransport } from "@modelcontextprotocol/client";
import { BearerAuth, OAuth } from 'fastmcp-ts/client'
import { StdioTransport, resolveTransport } from '../../src/client/transports.js'

describe('resolveTransport', () => {
  describe('URL string inference', () => {
    it('HTTP URL → StreamableHTTPClientTransport', async () => {
      const { transport } = await resolveTransport('http://localhost:3000/mcp')
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('HTTPS URL → StreamableHTTPClientTransport', async () => {
      const { transport } = await resolveTransport('https://api.example.com/mcp')
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('/sse path segment without legacySSE throws (deprecated transport requires opt-in)', async () => {
      await expect(resolveTransport('http://localhost:3000/sse')).rejects.toThrow(/deprecated/)
    })

    it('/sse path segment with legacySSE: true → SSEClientTransport', async () => {
      const { transport } = await resolveTransport('http://localhost:3000/sse', undefined, {
        legacySSE: true,
      })
      expect(transport).toBeInstanceOf(SSEClientTransport)
    })

    it('/sse/ path prefix with legacySSE: true → SSEClientTransport', async () => {
      const { transport } = await resolveTransport('http://localhost:3000/sse/messages', undefined, {
        legacySSE: true,
      })
      expect(transport).toBeInstanceOf(SSEClientTransport)
    })

    it('non-SSE path stays Streamable HTTP', async () => {
      const { transport } = await resolveTransport('http://localhost:3000/api/mcp')
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('throws on an invalid URL string', async () => {
      await expect(resolveTransport('not-a-url')).rejects.toThrow(/not a valid URL/)
    })
  })

  describe('URL scheme validation', () => {
    it('rejects a bare script path and points at StdioTransport', async () => {
      await expect(resolveTransport('harmful_script.py')).rejects.toThrow(
        /not a valid URL[\s\S]*StdioTransport/,
      )
    })

    it('rejects a relative script path', async () => {
      await expect(resolveTransport('./server.js')).rejects.toThrow(/not a valid URL/)
    })

    it('rejects a file: URL', async () => {
      await expect(resolveTransport('file:///tmp/server.py')).rejects.toThrow(
        /unsupported scheme "file:"/,
      )
    })

    it('rejects a python: scheme', async () => {
      await expect(resolveTransport('python:server.py')).rejects.toThrow(
        /unsupported scheme "python:"/,
      )
    })

    it('rejects a Windows-style path (parses as a c: scheme)', async () => {
      await expect(resolveTransport('C:\\scripts\\server.py')).rejects.toThrow(
        /unsupported scheme/,
      )
    })

    it('rejects a non-http scheme in an mcpServers url entry', async () => {
      await expect(
        resolveTransport({
          mcpServers: { myServer: { url: 'file:///tmp/server.py' } },
        }),
      ).rejects.toThrow(/unsupported scheme "file:"/)
    })
  })

  describe('StdioTransport config', () => {
    it('produces a StdioClientTransport', async () => {
      const { transport } = await resolveTransport(new StdioTransport('node', ['server.js']))
      expect(transport).toBeInstanceOf(StdioClientTransport)
    })

    it('lazily loads stdio only when requested', async () => {
      const { transport } = await resolveTransport(new StdioTransport('node', ['server.js']))
      expect(transport.constructor.name).toBe('StdioClientTransport')
    })

    it('passes command and args through', async () => {
      const { transport } = await resolveTransport(
        new StdioTransport('python', ['-m', 'myserver']),
      )
      expect(transport).toBeInstanceOf(StdioClientTransport)
    })
  })

  describe('pass-through SDK Transport', () => {
    it('returns the transport unchanged', async () => {
      const [, clientSide] = InMemoryTransport.createLinkedPair()
      const { transport } = await resolveTransport(clientSide)
      expect(transport).toBe(clientSide)
    })
  })

  describe('McpConfig object', () => {
    it('URL entry → StreamableHTTPClientTransport', async () => {
      const { transport } = await resolveTransport({
        mcpServers: { myServer: { url: 'http://localhost:3000/mcp' } },
      })
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('SSE URL entry without legacySSE throws', async () => {
      await expect(
        resolveTransport({
          mcpServers: { myServer: { url: 'http://localhost:3000/sse' } },
        }),
      ).rejects.toThrow(/deprecated/)
    })

    it('SSE URL entry with legacySSE: true → SSEClientTransport', async () => {
      const { transport } = await resolveTransport(
        { mcpServers: { myServer: { url: 'http://localhost:3000/sse' } } },
        undefined,
        { legacySSE: true },
      )
      expect(transport).toBeInstanceOf(SSEClientTransport)
    })

    it('command entry → StdioClientTransport', async () => {
      const { transport } = await resolveTransport({
        mcpServers: { myServer: { command: 'node', args: ['server.js'] } },
      })
      expect(transport).toBeInstanceOf(StdioClientTransport)
    })

    it('uses the first entry when multiple servers are defined', async () => {
      const { transport } = await resolveTransport({
        mcpServers: {
          first: { url: 'http://localhost:3000/mcp' },
          second: { command: 'node', args: ['server.js'] },
        },
      })
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    })

    it('throws when mcpServers is empty', async () => {
      await expect(resolveTransport({ mcpServers: {} })).rejects.toThrow('empty')
    })

    it('rejects a raw string entry with a clear error', async () => {
      await expect(
        resolveTransport({ mcpServers: { myServer: 'harmful_script.py' as never } }),
      ).rejects.toThrow(/must be an object with a "url" or "command" key/)
    })
  })

  describe('in-process server (McpServerLike)', () => {
    it('returns an InMemoryTransport', async () => {
      const fakeServer = {
        connect: async () => {},
      }
      const { transport } = await resolveTransport(fakeServer)
      expect(transport).toBeInstanceOf(InMemoryTransport)
    })

    it('provides a beforeConnect hook that calls server.connect', async () => {
      const calls: unknown[] = []
      const fakeServer = {
        connect: async (t: unknown) => { calls.push(t) },
      }
      const { transport, beforeConnect } = await resolveTransport(fakeServer)
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
    it('BearerAuth is accepted without throwing', async () => {
      const auth = new BearerAuth('tok')
      await expect(resolveTransport('http://localhost/mcp', auth)).resolves.toBeDefined()
    })

    it('OAuth is accepted without throwing', async () => {
      const auth = new OAuth({ onRedirect: () => {} })
      await expect(resolveTransport('http://localhost/mcp', auth)).resolves.toBeDefined()
    })
  })

  describe('error cases', () => {
    it('throws on unrecognized input', async () => {
      await expect(resolveTransport(42 as never)).rejects.toThrow()
    })
  })
})
