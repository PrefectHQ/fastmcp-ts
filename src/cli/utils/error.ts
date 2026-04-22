import { theme } from '../ui/theme.js'
import { symbols } from '../ui/symbols.js'

export const EXIT = {
  OK: 0,
  USER: 1,
  CONNECTION: 2,
  SERVER: 3,
} as const

export interface CliErrorOptions {
  hint?: string
  code?: number
}

export function cliError(message: string, opts: CliErrorOptions = {}): never {
  process.stderr.write(`${theme.error(symbols.failure)} ${theme.error(message)}\n`)
  if (opts.hint) {
    process.stderr.write(`  ${theme.muted(opts.hint)}\n`)
  }
  process.exit(opts.code ?? EXIT.USER)
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (msg.includes('econnrefused') || msg.includes('connection refused')) {
      return `Connection refused — is the server running?`
    }
    if (msg.includes('unauthorized') || msg.includes('401')) {
      return `Authentication failed — check your --auth token`
    }
    if (msg.includes('not found') || msg.includes('404')) {
      return err.message
    }
    return err.message
  }
  return String(err)
}
