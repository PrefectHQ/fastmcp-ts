import { theme } from './theme.js'
import { symbols } from './symbols.js'

let quiet = false

export function setQuiet(value: boolean): void {
  quiet = value
}

export function isQuiet(): boolean {
  return quiet
}

export const log = {
  info(message: string): void {
    if (quiet) return
    process.stderr.write(`${theme.muted(symbols.info)} ${message}\n`)
  },

  success(message: string): void {
    if (quiet) return
    process.stderr.write(`${theme.success(symbols.success)} ${message}\n`)
  },

  warn(message: string): void {
    if (quiet) return
    process.stderr.write(`${theme.warning(symbols.warning)} ${theme.warning(message)}\n`)
  },

  error(message: string): void {
    process.stderr.write(`${theme.error(symbols.failure)} ${theme.error(message)}\n`)
  },

  muted(message: string): void {
    if (quiet) return
    process.stderr.write(`${theme.muted(message)}\n`)
  },

  section(title: string): void {
    if (quiet) return
    process.stderr.write(`\n${theme.primary(title)}\n${theme.muted(symbols.separator)}\n`)
  },

  kv(key: string, value: string): void {
    if (quiet) return
    process.stderr.write(`${theme.label(key.padEnd(12))} ${theme.value(value)}\n`)
  },

  raw(message: string): void {
    process.stdout.write(`${message}\n`)
  },
}
