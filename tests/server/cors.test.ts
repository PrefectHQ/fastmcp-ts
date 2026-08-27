import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CORS_ALLOWED_HEADERS,
  corsPreflightHeaders,
  corsResponseHeaders,
  resolveCors,
} from '../../src/server/cors'

describe('resolveCors', () => {
  it('true and undefined resolve to the permissive defaults', () => {
    for (const input of [true, undefined] as const) {
      const cors = resolveCors(input)!
      expect(cors.originMode).toEqual({ kind: 'any' })
      expect(cors.methods).toBe('GET, POST, DELETE, OPTIONS')
      expect(cors.allowedHeaders).toBe(DEFAULT_CORS_ALLOWED_HEADERS.join(', '))
      expect(cors.exposedHeaders).toBe('Mcp-Session-Id')
      expect(cors.credentials).toBe(false)
      expect(cors.maxAge).toBeNull()
    }
  })

  it('false disables CORS', () => {
    expect(resolveCors(false)).toBeNull()
  })

  it('normalizes a single origin string to a one-entry list', () => {
    const cors = resolveCors({ origin: 'https://app.example.com' })!
    expect(cors.originMode).toEqual({ kind: 'list', origins: new Set(['https://app.example.com']) })
  })

  it('rejects credentials with the wildcard origin', () => {
    expect(() => resolveCors({ credentials: true })).toThrow(/credentials: true requires an explicit origin/)
    expect(() => resolveCors({ credentials: true, origin: '*' })).toThrow(/credentials: true requires an explicit origin/)
  })

  it('rejects a trailing-slash origin', () => {
    expect(() => resolveCors({ origin: 'https://app.example.com/' })).toThrow(/trailing slash/)
  })

  it('rejects an empty origin list, empty methods, and a bad maxAge', () => {
    expect(() => resolveCors({ origin: [] })).toThrow(/cors\.origin/)
    expect(() => resolveCors({ methods: [] })).toThrow(/cors\.methods/)
    expect(() => resolveCors({ maxAge: -1 })).toThrow(/cors\.maxAge/)
    expect(() => resolveCors({ maxAge: 1.5 })).toThrow(/cors\.maxAge/)
  })

  it('merges allowedHeaders and exposedHeaders additively, deduplicating case-insensitively', () => {
    const cors = resolveCors({
      allowedHeaders: ['X-Custom', 'content-type'],
      exposedHeaders: ['X-Trace-Id', 'mcp-session-id'],
    })!
    expect(cors.allowedHeaders).toBe([...DEFAULT_CORS_ALLOWED_HEADERS, 'X-Custom'].join(', '))
    expect(cors.exposedHeaders).toBe('Mcp-Session-Id, X-Trace-Id')
  })

  it('methods replace the default list verbatim, uppercased and deduplicated', () => {
    const cors = resolveCors({ methods: ['get', 'POST', 'get'] })!
    expect(cors.methods).toBe('GET, POST')
  })

  it('rejects string values for allowedHeaders and exposedHeaders', () => {
    expect(() => resolveCors({ allowedHeaders: 'X-Custom' as never })).toThrow(/cors\.allowedHeaders/)
    expect(() => resolveCors({ exposedHeaders: 'X-Trace' as never })).toThrow(/cors\.exposedHeaders/)
  })
})

describe('corsPreflightHeaders / corsResponseHeaders', () => {
  it('wildcard mode answers every origin with * and no Vary', () => {
    const cors = resolveCors(true)!
    const preflight = corsPreflightHeaders(cors, 'https://anywhere.example')
    expect(preflight['Access-Control-Allow-Origin']).toBe('*')
    expect(preflight['Vary']).toBeUndefined()
    expect(preflight['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS')
    expect(preflight['Access-Control-Allow-Headers']).toContain('Mcp-Session-Id')
    const response = corsResponseHeaders(cors, undefined)
    expect(response['Access-Control-Allow-Origin']).toBe('*')
    expect(response['Access-Control-Expose-Headers']).toBe('Mcp-Session-Id')
  })

  it('list mode echoes an allowed origin with Vary and omits ACAO otherwise', () => {
    const cors = resolveCors({ origin: ['https://a.example', 'https://b.example'] })!
    const allowed = corsResponseHeaders(cors, 'https://b.example')
    expect(allowed['Access-Control-Allow-Origin']).toBe('https://b.example')
    expect(allowed['Vary']).toBe('Origin')
    const denied = corsResponseHeaders(cors, 'https://evil.example')
    expect(denied['Access-Control-Allow-Origin']).toBeUndefined()
    expect(denied['Vary']).toBe('Origin')
    const absent = corsResponseHeaders(cors, undefined)
    expect(absent['Access-Control-Allow-Origin']).toBeUndefined()
    expect(absent['Vary']).toBe('Origin')
  })

  it('predicate mode consults the function', () => {
    const cors = resolveCors({ origin: (o) => o.endsWith('.example.com') })!
    expect(corsResponseHeaders(cors, 'https://app.example.com')['Access-Control-Allow-Origin']).toBe(
      'https://app.example.com',
    )
    expect(corsResponseHeaders(cors, 'https://app.example.org')['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('credentials and maxAge appear only when configured, on the right response kind', () => {
    const cors = resolveCors({ origin: 'https://a.example', credentials: true, maxAge: 600 })!
    const preflight = corsPreflightHeaders(cors, 'https://a.example')
    expect(preflight['Access-Control-Allow-Credentials']).toBe('true')
    expect(preflight['Access-Control-Max-Age']).toBe('600')
    const response = corsResponseHeaders(cors, 'https://a.example')
    expect(response['Access-Control-Allow-Credentials']).toBe('true')
    expect(response['Access-Control-Max-Age']).toBeUndefined()
    expect(response['Access-Control-Allow-Methods']).toBeUndefined()
  })
})
