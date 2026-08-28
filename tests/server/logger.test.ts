import { describe, expect, it, vi, afterEach } from 'vitest'
import { DefaultSink, ResolvedLogger, resolveLogger } from '../../src/server/logger'
import { theme, symbols } from '../../src/shared/terminal'
import { theme as cliTheme } from '../../src/cli/ui/theme.js'

describe('shared terminal module', () => {
  it('CLI re-export is the same object', () => {
    expect(cliTheme).toBe(theme)
  })
})

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk))
    return true
  })
  return { lines, restore: () => spy.mockRestore() }
}

describe('resolveLogger', () => {
  afterEach(() => { delete process.env['FASTMCP_LOG_LEVEL'] })

  it('defaults to info with the built-in sink', () => {
    const log = resolveLogger(undefined, undefined)
    expect(log.level).toBe('info')
  })

  it('level precedence: option > env > info', () => {
    process.env['FASTMCP_LOG_LEVEL'] = 'error'
    expect(resolveLogger(undefined, undefined).level).toBe('error')
    expect(resolveLogger(undefined, 'debug').level).toBe('debug')
  })

  it('env value is case-insensitive and trimmed', () => {
    process.env['FASTMCP_LOG_LEVEL'] = '  WARN '
    expect(resolveLogger(undefined, undefined).level).toBe('warn')
  })

  it('throws on a malformed logLevel option', () => {
    expect(() => resolveLogger(undefined, 'verbose' as never)).toThrow(/logLevel/)
  })

  it('throws on a malformed env value', () => {
    process.env['FASTMCP_LOG_LEVEL'] = 'loud'
    expect(() => resolveLogger(undefined, undefined)).toThrow(/FASTMCP_LOG_LEVEL/)
  })

  it('throws on a logger missing methods', () => {
    expect(() => resolveLogger({ info: () => {} } as never, undefined)).toThrow(/logger/)
  })

  it('gates calls below the threshold before the sink sees them', () => {
    const calls: string[] = []
    const sink = {
      debug: (m: string) => calls.push(`debug:${m}`),
      info: (m: string) => calls.push(`info:${m}`),
      warn: (m: string) => calls.push(`warn:${m}`),
      error: (m: string) => calls.push(`error:${m}`),
    }
    const log = resolveLogger(sink, 'warn')
    log.debug('a'); log.info('b'); log.warn('c'); log.error('d')
    expect(calls).toEqual(['warn:c', 'error:d'])
  })

  it('silent drops everything, banner included', () => {
    const calls: string[] = []
    const sink = { debug: () => calls.push('x'), info: () => calls.push('x'), warn: () => calls.push('x'), error: () => calls.push('x') }
    const log = resolveLogger(sink, 'silent')
    log.error('boom')
    log.startupBanner({ name: 'n', version: '1.0.0', transport: 'stdio' })
    expect(calls).toEqual([])
  })

  it('passes meta through to an injected sink untouched (no ANSI, no prefix)', () => {
    const seen: Array<[string, unknown]> = []
    const sink = { debug: () => {}, info: (m: string, x?: unknown) => seen.push([m, x]), warn: () => {}, error: () => {} }
    resolveLogger(sink, 'info').info('hello', { component: 'proxy' })
    expect(seen).toEqual([['hello', { component: 'proxy' }]])
    expect(seen[0]![0]).not.toMatch(/\x1b\[/)
    expect(seen[0]![0]).not.toContain('[fastmcp]')
  })
})

describe('DefaultSink plain mode', () => {
  it('formats [fastmcp] LEVEL message with JSON meta, to stderr', () => {
    const { lines, restore } = capture()
    try {
      const sink = new DefaultSink('plain')
      sink.warn('something odd', { component: 'tool', count: 2 })
      sink.info('plain line')
    } finally { restore() }
    expect(lines[0]).toBe('[fastmcp] WARN something odd {"component":"tool","count":2}\n')
    expect(lines[1]).toBe('[fastmcp] INFO plain line\n')
  })

  it('stringifies Error meta values readably', () => {
    const { lines, restore } = capture()
    try { new DefaultSink('plain').error('failed', { error: new Error('nope') }) } finally { restore() }
    expect(lines[0]).toContain('Error: nope')
  })
})
