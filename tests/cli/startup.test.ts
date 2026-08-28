import { describe, expect, it, vi, beforeEach } from 'vitest'
import { setQuiet } from '../../src/cli/ui/output.js'

// Shared mock state for the '@clack/prompts' spinner factory. Must be
// created via vi.hoisted() so the vi.mock() factory below (which vitest
// hoists above these imports) can reference it.
const spinnerState = vi.hoisted(() => ({
  calls: [] as Array<{
    options: Record<string, unknown> | undefined
    start: string[]
    stop: string[]
    error: string[]
  }>,
}))

vi.mock('@clack/prompts', () => ({
  spinner: vi.fn((options?: Record<string, unknown>) => {
    const record = { options, start: [] as string[], stop: [] as string[], error: [] as string[] }
    spinnerState.calls.push(record)
    return {
      start: (msg?: string) => { record.start.push(msg ?? '') },
      stop: (msg?: string) => { record.stop.push(msg ?? '') },
      error: (msg?: string) => { record.error.push(msg ?? '') },
      cancel: (_msg?: string) => {},
      message: (_msg?: string) => {},
      clear: () => {},
      get isCancelled() { return false },
    }
  }),
}))

import { createStartupReporter } from '../../src/cli/ui/startup.js'

/** Force process.stdout.isTTY to true for the duration of fn, then restore it. */
function withTTY<T>(fn: () => T): T {
  const original = process.stdout.isTTY
  process.stdout.isTTY = true
  try {
    return fn()
  } finally {
    process.stdout.isTTY = original
  }
}

describe('createStartupReporter', () => {
  beforeEach(() => {
    spinnerState.calls.length = 0
  })

  it('non-animated reporter passes stderr through and marks started on the sniff words', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true })
    try {
      const r = createStartupReporter({ animate: false })
      r.onStderr('warming up\n')
      expect(r.done).toBe(false)
      r.onStderr('listening on http://x\n')
      expect(r.done).toBe(true)
      expect(writes.join('')).toContain('warming up')
      expect(writes.join('')).toContain('Server started')
    } finally { spy.mockRestore() }
  })

  it('first stdout chunk also completes startup', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const r = createStartupReporter({ animate: false })
      r.onStdout('{"jsonrpc":"2.0"}\n')
      expect(r.done).toBe(true)
    } finally { spy.mockRestore(); outSpy.mockRestore() }
  })

  it('does not mark started twice: a second sniff word does not re-flush', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true })
    try {
      const r = createStartupReporter({ animate: false })
      r.onStderr('listening on http://x\n')
      const countAfterFirst = writes.filter((w) => w.includes('Server started')).length
      r.onStderr('running again\n')
      const countAfterSecond = writes.filter((w) => w.includes('Server started')).length
      expect(countAfterFirst).toBe(1)
      expect(countAfterSecond).toBe(1)
    } finally { spy.mockRestore() }
  })

  it('fail() before detection marks done and reports a failure, not success', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true })
    try {
      const r = createStartupReporter({ animate: false })
      expect(r.done).toBe(false)
      r.fail()
      expect(r.done).toBe(true)
      expect(writes.join('')).not.toContain('Server started')
    } finally { spy.mockRestore() }
  })

  it('fail() after detection is a no-op (does not write a second time)', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true })
    try {
      const r = createStartupReporter({ animate: false })
      r.onStderr('listening on http://x\n')
      const before = writes.length
      r.fail()
      expect(writes.length).toBe(before)
    } finally { spy.mockRestore() }
  })

  it('non-TTY stdout disables animation even when animate: true is requested', () => {
    // process.stdout.isTTY is not defined (or false) under vitest/execa, so
    // requesting animate: true should still behave as non-animated: stderr
    // passes through immediately with no spinner buffering.
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true })
    try {
      const r = createStartupReporter({ animate: true })
      r.onStderr('warming up\n')
      expect(writes.join('')).toContain('warming up')
    } finally { spy.mockRestore() }
  })

  // Fix round 1, item 4 (controller ruling): the !isQuiet() gate on the
  // "Server started" line stays. This is a disclosed behavior change from
  // the pre-Task-9 code, which always wrote that line unconditionally.
  it('quiet mode suppresses the "Server started" line but still passes stderr through', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true })
    try {
      setQuiet(true)
      const r = createStartupReporter({ animate: false })
      r.onStderr('warming up\n')
      r.onStderr('listening on http://x\n')
      expect(r.done).toBe(true)
      const joined = writes.join('')
      expect(joined).toContain('warming up')
      expect(joined).toContain('listening on http://x')
      expect(joined).not.toContain('Server started')
    } finally {
      setQuiet(false)
      spy.mockRestore()
    }
  })

  describe('animated branch (TTY, spinner live)', () => {
    it('constructs the spinner with output: process.stderr, not stdout', () => {
      withTTY(() => {
        createStartupReporter({ animate: true })
        expect(spinnerState.calls.length).toBe(1)
        expect(spinnerState.calls[0]?.options).toMatchObject({ output: process.stderr })
      })
    })

    it('buffers stderr chunks while animating and flushes them in arrival order once startup is detected', () => {
      withTTY(() => {
        const writes: string[] = []
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true })
        try {
          const r = createStartupReporter({ animate: true })
          r.onStderr('warming up\n')
          r.onStderr('still warming up\n')
          // Nothing reaches stderr yet: both lines sit behind the live
          // spinner. The spinner's own frames go through the mocked
          // start/stop/error calls, not process.stderr.write, so any write
          // captured here would only be a real flush.
          expect(writes.join('')).toBe('')

          r.onStderr('listening on http://x\n')
          expect(r.done).toBe(true)

          const joined = writes.join('')
          expect(joined).toContain('warming up')
          expect(joined).toContain('still warming up')
          expect(joined).toContain('listening on http://x')
          const iWarming = joined.indexOf('warming up')
          const iStillWarming = joined.indexOf('still warming up')
          const iListening = joined.indexOf('listening on http://x')
          expect(iWarming).toBeLessThan(iStillWarming)
          expect(iStillWarming).toBeLessThan(iListening)
        } finally { spy.mockRestore() }
      })
    })

    it('on success, calls the spinner stop method (not error)', () => {
      withTTY(() => {
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        try {
          const r = createStartupReporter({ animate: true })
          r.onStderr('listening on http://x\n')
          expect(r.done).toBe(true)
          const record = spinnerState.calls[0]
          expect(record?.stop.length).toBe(1)
          expect(record?.error.length).toBe(0)
        } finally { spy.mockRestore() }
      })
    })

    it('child death pre-detection calls the spinner error method (not stop) and flushes the buffer', () => {
      withTTY(() => {
        const writes: string[] = []
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { writes.push(String(c)); return true })
        try {
          const r = createStartupReporter({ animate: true })
          r.onStderr('warming up\n')
          expect(writes.join('')).toBe('')

          r.fail()
          expect(r.done).toBe(true)

          const record = spinnerState.calls[0]
          expect(record?.error.length).toBe(1)
          expect(record?.stop.length).toBe(0)
          expect(writes.join('')).toContain('warming up')
        } finally { spy.mockRestore() }
      })
    })
  })
})
