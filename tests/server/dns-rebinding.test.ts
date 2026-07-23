import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { FastMCP } from 'fastmcp-ts/server'
// Test-only reset of the once-per-process warning guard (not part of the public entry).
import { __resetDnsRebindingWarningForTests } from '../../src/server/FastMCP.js'

// ---------------------------------------------------------------------------
// DNS-rebinding protection (Host / Origin validation on the HTTP transport).
//
// Mirrors the official conformance scenario `dns-rebinding-protection`: a
// localhost-bound MCP server MUST reject requests whose Host/Origin is not a
// localhost value (HTTP 4xx) and MUST accept valid localhost Host/Origin. The
// attack is simulated by connecting the socket to the real bound loopback
// address while sending an attacker-controlled `Host` header.
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number
  body: string
}

/**
 * Raw `initialize` POST with arbitrary Host/Origin headers. The socket connects
 * to `connectHost:port` (the real bound loopback address); the `Host`/`Origin`
 * headers are whatever the caller supplies — this is the DNS-rebinding shape the
 * conformance suite uses (undici `request`; we use `node:http` for the same
 * header control that `fetch` forbids).
 */
function rawInitialize(
  connectHost: string,
  port: number,
  path: string,
  headers: { host?: string; origin?: string; extra?: Record<string, string>; protocolVersion?: string },
): Promise<RawResponse> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: headers.protocolVersion ?? '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'dns-rebinding-test', version: '1.0.0' },
    },
  })
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: connectHost,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          ...(headers.host !== undefined ? { Host: headers.host } : {}),
          ...(headers.origin !== undefined ? { Origin: headers.origin } : {}),
          ...(headers.extra ?? {}),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

// Every test resets the once-per-process warning guard and suppresses the warning so
// the file's output stays pristine; the warning cases below read `warnSpy` directly.
let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  __resetDnsRebindingWarningForTests()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
})

/** Count of DNS-rebinding warnings captured by the spy. */
function dnsWarnCount(): number {
  return warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('dnsRebinding')).length
}

describe('DNS-rebinding protection', () => {
  describe('default posture — loopback bind auto-enables', () => {
    it('rejects a non-localhost Host with 403 and accepts a localhost Host', async () => {
      const mcp = new FastMCP({ name: 'dns' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      const { port, path } = mcp.address!
      try {
        const evil = await rawInitialize('127.0.0.1', port, path, {
          host: 'evil.example.com',
          origin: 'http://evil.example.com',
        })
        expect(evil.status).toBe(403)
        // Same JSON-RPC rejection shape the SDK's host guard emits.
        expect(JSON.parse(evil.body)).toMatchObject({ error: { code: -32000 } })

        const ok = await rawInitialize('127.0.0.1', port, path, {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
        })
        expect(ok.status).toBeGreaterThanOrEqual(200)
        expect(ok.status).toBeLessThan(300)
      } finally {
        await mcp.close()
      }
    })

    it('rejects a non-localhost Origin (localhost Host) with 403', async () => {
      const mcp = new FastMCP({ name: 'dns' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      const { port, path } = mcp.address!
      try {
        const res = await rawInitialize('127.0.0.1', port, path, {
          host: `127.0.0.1:${port}`,
          origin: 'http://evil.example.com',
        })
        expect(res.status).toBe(403)
      } finally {
        await mcp.close()
      }
    })

    it('guards the modern (2026-07-28) branch too — evil Host on a modern request is 403', async () => {
      const mcp = new FastMCP({ name: 'dns' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      const { port, path } = mcp.address!
      try {
        // Modern-classified request (server/discover + modern standard headers). The
        // guard runs before the legacy/modern split, so it rejects before dispatch.
        const res = await rawInitialize('127.0.0.1', port, path, {
          host: 'evil.example.com',
          origin: 'http://evil.example.com',
          protocolVersion: '2026-07-28',
          extra: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' },
        })
        expect(res.status).toBe(403)
      } finally {
        await mcp.close()
      }
    })
  })

  describe('deliberate default — non-loopback bind stays open', () => {
    it('does NOT reject a non-localhost Host when bound to 0.0.0.0 (opt-in for exposed deployments)', async () => {
      const mcp = new FastMCP({ name: 'dns' })
      await mcp.run({ transport: 'http', port: 0, host: '0.0.0.0' })
      const { port, path } = mcp.address!
      try {
        const res = await rawInitialize('127.0.0.1', port, path, {
          host: 'evil.example.com',
          origin: 'http://evil.example.com',
        })
        expect(res.status).not.toBe(403)
      } finally {
        await mcp.close()
      }
    })
  })

  describe('explicit configuration', () => {
    it('enabled:true forces protection on even for a non-loopback bind', async () => {
      const mcp = new FastMCP({ name: 'dns', dnsRebinding: { enabled: true } })
      await mcp.run({ transport: 'http', port: 0, host: '0.0.0.0' })
      const { port, path } = mcp.address!
      try {
        const res = await rawInitialize('127.0.0.1', port, path, {
          host: 'evil.example.com',
          origin: 'http://evil.example.com',
        })
        expect(res.status).toBe(403)
      } finally {
        await mcp.close()
      }
    })

    it('enabled:false forces protection off even for a loopback bind', async () => {
      const mcp = new FastMCP({ name: 'dns', dnsRebinding: { enabled: false } })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      const { port, path } = mcp.address!
      try {
        const res = await rawInitialize('127.0.0.1', port, path, {
          host: 'evil.example.com',
          origin: 'http://evil.example.com',
        })
        expect(res.status).not.toBe(403)
      } finally {
        await mcp.close()
      }
    })

    it('a custom allowedHosts list admits the named host and rejects others', async () => {
      const mcp = new FastMCP({ name: 'dns', dnsRebinding: { allowedHosts: ['api.example.com'] } })
      await mcp.run({ transport: 'http', port: 0, host: '0.0.0.0' })
      const { port, path } = mcp.address!
      try {
        const allowed = await rawInitialize('127.0.0.1', port, path, { host: 'api.example.com' })
        expect(allowed.status).not.toBe(403)
        const rejected = await rawInitialize('127.0.0.1', port, path, { host: 'evil.example.com' })
        expect(rejected.status).toBe(403)
      } finally {
        await mcp.close()
      }
    })
  })

  describe('open-by-default warning', () => {
    it('warns exactly once when a routable host binds with no dnsRebinding config', async () => {
      const mcp = new FastMCP({ name: 'dns' })
      await mcp.run({ transport: 'http', port: 0, host: '0.0.0.0' })
      try {
        expect(dnsWarnCount()).toBe(1)
      } finally {
        await mcp.close()
      }
      // Once per process: a second routable serve in the same process stays silent.
      const mcp2 = new FastMCP({ name: 'dns2' })
      await mcp2.run({ transport: 'http', port: 0, host: '0.0.0.0' })
      try {
        expect(dnsWarnCount()).toBe(1)
      } finally {
        await mcp2.close()
      }
    })

    it('does not warn when bound to a loopback host', async () => {
      const mcp = new FastMCP({ name: 'dns' })
      await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
      try {
        expect(dnsWarnCount()).toBe(0)
      } finally {
        await mcp.close()
      }
    })

    it('does not warn when dnsRebinding is explicitly disabled on a routable host', async () => {
      const mcp = new FastMCP({ name: 'dns', dnsRebinding: { enabled: false } })
      await mcp.run({ transport: 'http', port: 0, host: '0.0.0.0' })
      try {
        expect(dnsWarnCount()).toBe(0)
      } finally {
        await mcp.close()
      }
    })
  })
})
