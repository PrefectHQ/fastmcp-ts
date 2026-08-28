import { spinner as clackSpinner } from '@clack/prompts'
import { theme } from './theme.js'
import { symbols } from './symbols.js'
import { isQuiet } from './output.js'

const SNIFF = ['listening', 'started', 'running']

// A stdio child never emits any SNIFF word (they only ever appear in an HTTP
// server's "listening" line), and an HTTP child with FASTMCP_LOG_LEVEL set to
// warn/silent never prints one either. Without a deadline, the buffer above
// would hold every line for the entire process lifetime and the user would
// see nothing. When this fires with startup still undetected, stop animating
// and let output stream live from then on.
const FLUSH_DEADLINE_MS = 10_000

/**
 * Startup feedback for spawned servers. While animating, child stderr is
 * buffered so log lines do not tear the spinner row; everything flushes the
 * moment startup is detected (sniff word on stderr, or any stdout byte), or
 * once FLUSH_DEADLINE_MS passes without detection, whichever comes first.
 * Child stdout always passes straight through: it may be protocol traffic.
 */
export function createStartupReporter(opts: { animate: boolean }): {
  onStdout(text: string): void
  onStderr(text: string): void
  fail(): void
  done: boolean
} {
  const animate = opts.animate && process.stdout.isTTY === true && !isQuiet()
  const buffered: string[] = []
  let spin: ReturnType<typeof clackSpinner> | null = null
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  if (animate) {
    // Decoration always belongs on stderr in this CLI: the child's real
    // stdout may be protocol traffic, and the spinner must never share
    // that stream (clack defaults its own output to stdout otherwise).
    spin = clackSpinner({ output: process.stderr })
    spin.start(theme.muted(`${symbols.info} Starting server${symbols.ellipsis}`))
    deadlineTimer = setTimeout(() => {
      if (state.done || !spin) return
      spin.stop(theme.muted(`still waiting for the server${symbols.ellipsis}`))
      spin = null
      for (const chunk of buffered.splice(0)) process.stderr.write(chunk)
    }, FLUSH_DEADLINE_MS)
    // Never hold the process open just to fire this deadline.
    deadlineTimer.unref()
  }
  const state = {
    done: false,
    finish(ok: boolean): void {
      if (state.done) return
      state.done = true
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
      if (spin) {
        if (ok) spin.stop(theme.success(`${symbols.success} Server started`))
        else spin.error(theme.error(`${symbols.failure} Server exited before starting`))
      } else if (!isQuiet()) {
        process.stderr.write(ok ? `${theme.success(symbols.success)} Server started\n` : `${theme.error(symbols.failure)} Server exited before starting\n`)
      }
      for (const chunk of buffered.splice(0)) process.stderr.write(chunk)
    },
    onStdout(text: string): void {
      state.finish(true)
      process.stdout.write(text)
    },
    onStderr(text: string): void {
      const hit = SNIFF.some((w) => text.includes(w))
      if (!state.done && spin && !hit) { buffered.push(text); return }
      if (hit) state.finish(true)
      process.stderr.write(text)
    },
    fail(): void { state.finish(false) },
  }
  return state
}
