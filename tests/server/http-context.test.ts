import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  buildHttpRequestContext,
  nodeRequestToHttpContext,
  resolveSensitiveHeaders,
  DEFAULT_SENSITIVE_HEADERS,
  forwardableHeaders,
} from '../../src/server/httpContext'
import { FastMCP } from 'fastmcp-ts/server'
import type { Middleware } from 'fastmcp-ts/server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { connectEra, describeEachEra, ERA_COMBOS } from '../helpers/eras'

describe('resolveSensitiveHeaders', () => {
  it('defaults to authorization, cookie, proxy-authorization, mcp-session-id', () => {
    expect([...resolveSensitiveHeaders()].sort()).toEqual(
      [...DEFAULT_SENSITIVE_HEADERS].sort(),
    )
  })

  it('redactHeaders adds (lowercased), exposeHeaders removes (lowercased)', () => {
    const set = resolveSensitiveHeaders({
      redactHeaders: ['X-Proxy-Secret'],
      exposeHeaders: ['Cookie'],
    })
    expect(set.has('x-proxy-secret')).toBe(true)
    expect(set.has('cookie')).toBe(false)
    expect(set.has('authorization')).toBe(true)
  })
})

describe('buildHttpRequestContext', () => {
  const SENSITIVE = resolveSensitiveHeaders()

  it('snapshots non-sensitive headers, method, and origin-form url', () => {
    const req = new Request('http://internal:8080/mcp?tenant=a', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1', 'X-Scopes': 'read write' },
    })
    const ctx = buildHttpRequestContext(req, SENSITIVE)
    expect(ctx.method).toBe('POST')
    expect(ctx.url).toBe('/mcp?tenant=a')
    expect(ctx.headers.get('x-user-id')).toBe('u1')
    expect(ctx.headers.get('X-USER-ID')).toBe('u1') // Headers is case-insensitive
    expect(ctx.redactedHeaderNames).toEqual([])
  })

  it('withholds sensitive headers and lists them in redactedHeaderNames', () => {
    const req = new Request('http://h/mcp', {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'sid=1',
        'X-User-Id': 'u1',
      },
    })
    const ctx = buildHttpRequestContext(req, SENSITIVE)
    expect(ctx.headers.get('authorization')).toBeNull()
    expect(ctx.headers.get('cookie')).toBeNull()
    expect(ctx.headers.get('x-user-id')).toBe('u1')
    expect(ctx.redactedHeaderNames).toEqual(['authorization', 'cookie']) // sorted
  })

  it('honors a custom sensitive set', () => {
    const req = new Request('http://h/mcp', {
      headers: { 'X-Proxy-Secret': 's3cret', Cookie: 'sid=1' },
    })
    const ctx = buildHttpRequestContext(
      req,
      resolveSensitiveHeaders({ redactHeaders: ['x-proxy-secret'], exposeHeaders: ['cookie'] }),
    )
    expect(ctx.headers.get('x-proxy-secret')).toBeNull()
    expect(ctx.headers.get('cookie')).toBe('sid=1')
    expect(ctx.redactedHeaderNames).toEqual(['x-proxy-secret'])
  })

  it('is a copy: mutating it does not touch the source request', () => {
    const req = new Request('http://h/mcp', { headers: { 'x-a': '1' } })
    const ctx = buildHttpRequestContext(req, SENSITIVE)
    ctx.headers.set('x-a', 'changed')
    expect(req.headers.get('x-a')).toBe('1')
  })
})

describe('nodeRequestToHttpContext', () => {
  it('converts node headers WITHOUT redaction (this feeds the auth gate)', () => {
    const fake = {
      headers: {
        'x-multi': ['a', 'b'],
        host: 'internal',
        authorization: 'Bearer zzz',
        'x-user-id': 'u1',
      },
      method: 'POST',
      url: '/mcp?x=1',
    } as unknown as IncomingMessage
    const ctx = nodeRequestToHttpContext(fake)
    expect(ctx.headers.get('x-multi')).toBe('a, b')
    expect(ctx.headers.get('authorization')).toBe('Bearer zzz')
    expect(ctx.redactedHeaderNames).toEqual([])
    expect(ctx.method).toBe('POST')
    expect(ctx.url).toBe('/mcp?x=1')
  })

  it('defaults method and url when absent', () => {
    const fake = { headers: {} } as unknown as IncomingMessage
    const ctx = nodeRequestToHttpContext(fake)
    expect(ctx.method).toBe('GET')
    expect(ctx.url).toBe('/')
  })
})

describe('forwardableHeaders', () => {
  it('drops credentials, hop-by-hop, framing, and mcp-* headers; keeps the rest', () => {
    const h = new Headers({
      authorization: 'Bearer secret',
      cookie: 'sid=1',
      host: 'internal',
      connection: 'keep-alive',
      'content-type': 'application/json',
      'content-length': '42',
      'mcp-session-id': 'abc',
      'mcp-protocol-version': '2026-07-28',
      'x-trace-id': 't-1',
      accept: 'application/json',
    })
    const out = forwardableHeaders(h)
    expect(out.get('x-trace-id')).toBe('t-1')
    expect(out.get('accept')).toBe('application/json')
    for (const name of [
      'authorization', 'cookie', 'host', 'connection', 'content-type',
      'content-length', 'mcp-session-id', 'mcp-protocol-version',
    ]) {
      expect(out.get(name)).toBeNull()
    }
  })

  it('include re-admits a dropped name, case-insensitively', () => {
    const out = forwardableHeaders(new Headers({ authorization: 'Bearer t' }), {
      include: ['Authorization'],
    })
    expect(out.get('authorization')).toBe('Bearer t')
  })

  it('returns a fresh Headers; the input is untouched', () => {
    const h = new Headers({ 'x-a': '1', authorization: 'Bearer t' })
    const out = forwardableHeaders(h)
    out.set('x-a', 'changed')
    expect(h.get('x-a')).toBe('1')
    expect(h.get('authorization')).toBe('Bearer t')
  })
})

describeEachEra('Server — ctx.http', (combo) => {
  it('exposes the carrying request headers on HTTP transports; undefined on stdio', async () => {
    const mcp = new FastMCP({ name: 'test' })
    let seen:
      | { present: boolean; userId: string | null; method?: string; url?: string }
      | undefined
    mcp.tool({ name: 'probe', description: 'test' }, () => {
      const http = mcp.getContext().http
      seen = http
        ? {
            present: true,
            userId: http.headers.get('x-user-id'),
            method: http.method,
            url: http.url,
          }
        : { present: false, userId: null }
      return 'ok'
    })
    const { client, close } = await connectEra(mcp, combo, {
      httpHeaders: { 'X-User-Id': 'u-42' },
    })
    try {
      await client.callTool({ name: 'probe', arguments: {} })
      if (combo.transport === 'http') {
        expect(seen).toMatchObject({ present: true, userId: 'u-42', method: 'POST' })
        expect(seen!.url!.startsWith('/')).toBe(true)
      } else {
        expect(seen).toEqual({ present: false, userId: null })
      }
    } finally {
      await close()
    }
  })

  it('redacts credential headers by default and lists them in redactedHeaderNames', async () => {
    const mcp = new FastMCP({ name: 'test' })
    let seen:
      | { auth: string | null; cookie: string | null; custom: string | null; redacted: readonly string[] }
      | undefined
    mcp.tool({ name: 'probe', description: 'test' }, () => {
      const http = mcp.getContext().http
      if (http) {
        seen = {
          auth: http.headers.get('authorization'),
          cookie: http.headers.get('cookie'),
          custom: http.headers.get('x-user-id'),
          redacted: http.redactedHeaderNames,
        }
      }
      return 'ok'
    })
    const { client, close } = await connectEra(mcp, combo, {
      httpHeaders: {
        Authorization: 'Bearer super-secret',
        Cookie: 'sid=1',
        'X-User-Id': 'u-42',
      },
    })
    try {
      await client.callTool({ name: 'probe', arguments: {} })
      if (combo.transport === 'http') {
        expect(seen!.auth).toBeNull()
        expect(seen!.cookie).toBeNull()
        expect(seen!.custom).toBe('u-42')
        expect(seen!.redacted).toEqual(expect.arrayContaining(['authorization', 'cookie']))
        expect(seen!.redacted).not.toContain('x-user-id')
      } else {
        expect(seen).toBeUndefined()
      }
    } finally {
      await close()
    }
  })

  it('middleware reaches the same per-request http context via ctx.mcpContext', async () => {
    let seenByMw: string | null | undefined
    const recorder: Middleware = {
      async onCallTool(ctx, next) {
        seenByMw = ctx.mcpContext.http?.headers.get('x-user-id') ?? null
        return next()
      },
    }
    const mcp = new FastMCP({ name: 'test', middleware: [recorder] })
    mcp.tool({ name: 'probe', description: 'test' }, () => 'ok')
    const { client, close } = await connectEra(mcp, combo, {
      httpHeaders: { 'X-User-Id': 'u-mw' },
    })
    try {
      await client.callTool({ name: 'probe', arguments: {} })
      expect(seenByMw).toBe(combo.transport === 'http' ? 'u-mw' : null)
    } finally {
      await close()
    }
  })
})

describe('ctx.http redaction configuration', () => {
  it('exposeHeaders/redactHeaders adjust the sensitive set end-to-end', async () => {
    const mcp = new FastMCP({
      name: 'test',
      http: { exposeHeaders: ['cookie'], redactHeaders: ['x-internal-key'] },
    })
    let seen:
      | { cookie: string | null; internal: string | null; auth: string | null; redacted: readonly string[] }
      | undefined
    mcp.tool({ name: 'probe', description: 'test' }, () => {
      const http = mcp.getContext().http!
      seen = {
        cookie: http.headers.get('cookie'),
        internal: http.headers.get('x-internal-key'),
        auth: http.headers.get('authorization'),
        redacted: http.redactedHeaderNames,
      }
      return 'ok'
    })
    const combo = ERA_COMBOS.find((c) => c.name === 'http-legacy-sessionful')!
    const { client, close } = await connectEra(mcp, combo, {
      httpHeaders: {
        Cookie: 'sid=1',
        'X-Internal-Key': 'k-1',
        Authorization: 'Bearer t',
      },
    })
    try {
      await client.callTool({ name: 'probe', arguments: {} })
      expect(seen!.cookie).toBe('sid=1') // exposed by option
      expect(seen!.internal).toBeNull() // redacted by option
      expect(seen!.auth).toBeNull() // still redacted by default
      expect(seen!.redacted).toEqual(expect.arrayContaining(['authorization', 'x-internal-key']))
      expect(seen!.redacted).not.toContain('cookie')
    } finally {
      await close()
    }
  })
})

describe('ctx.http per-request freshness', () => {
  it('legacy sessionful: each request in one session sees its own headers', async () => {
    const mcp = new FastMCP({ name: 'test' })
    const tags: Array<string | null> = []
    mcp.tool({ name: 'probe', description: 'test' }, () => {
      tags.push(mcp.getContext().http?.headers.get('x-request-tag') ?? null)
      return 'ok'
    })
    const headers: Record<string, string> = { 'x-request-tag': 'first' }
    const combo = ERA_COMBOS.find((c) => c.name === 'http-legacy-sessionful')!
    const { client, close } = await connectEra(mcp, combo, { httpHeaders: headers })
    try {
      await client.callTool({ name: 'probe', arguments: {} })
      headers['x-request-tag'] = 'second'
      await client.callTool({ name: 'probe', arguments: {} })
      expect(tags).toEqual(['first', 'second'])
    } finally {
      await close()
    }
  })

  it('stateless http: ctx.http present per request', async () => {
    const mcp = new FastMCP({ name: 'test' })
    let userId: string | null = null
    mcp.tool({ name: 'probe', description: 'test' }, () => {
      userId = mcp.getContext().http?.headers.get('x-user-id') ?? null
      return 'ok'
    })
    await mcp.run({ transport: 'http', port: 0, stateless: true })
    const addr = mcp.address!
    const host = addr.host === '0.0.0.0' ? '127.0.0.1' : addr.host
    const url = new URL(`http://${host}:${addr.port}${addr.path}`)
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { 'X-User-Id': 'u-stateless' } },
        }),
      )
      await client.callTool({ name: 'probe', arguments: {} })
      expect(userId).toBe('u-stateless')
    } finally {
      await client.close().catch(() => {})
      await mcp.close()
    }
  })
})
