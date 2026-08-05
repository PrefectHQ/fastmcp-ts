import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  buildHttpRequestContext,
  nodeRequestToHttpContext,
  resolveSensitiveHeaders,
  DEFAULT_SENSITIVE_HEADERS,
} from '../../src/server/httpContext'

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
