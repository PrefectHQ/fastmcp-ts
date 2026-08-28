import { describe, expect, it } from 'vitest'
import { shouldAnimateStartup } from '../../src/cli/commands/run.js'

// Regression: `fastmcp run server.ts` defaults to the stdio transport (see the
// `transport` arg's default in run.ts). A stdio child never emits any of the
// startup reporter's sniff words on stderr (they only ever appear in an HTTP
// server's "listening" line), so animating for stdio buffers all child stderr
// output — including real errors — for the process lifetime on a TTY.
describe('shouldAnimateStartup', () => {
  it('never animates for the stdio transport, the default', () => {
    expect(shouldAnimateStartup('stdio', false)).toBe(false)
  })

  it('animates for http when not reloading', () => {
    expect(shouldAnimateStartup('http', false)).toBe(true)
  })

  it('animates for sse when not reloading', () => {
    expect(shouldAnimateStartup('sse', false)).toBe(true)
  })

  it('never animates with --reload, regardless of transport', () => {
    expect(shouldAnimateStartup('http', true)).toBe(false)
    expect(shouldAnimateStartup('stdio', true)).toBe(false)
  })
})
