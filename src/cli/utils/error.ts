import { theme } from '../ui/theme.js'
import { symbols } from '../ui/symbols.js'
import {
  ProtocolError,
  MissingRequiredClientCapabilityError,
  UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/client'

// The SDK does not export a dedicated class for -32020 (HeaderMismatch) — it
// surfaces as a plain ProtocolError with this code.
const HEADER_MISMATCH_CODE = -32020

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
  if (err instanceof UnsupportedProtocolVersionError) {
    return `The server does not support protocol version "${err.requested}". It supports: ${err.supported.join(', ')}. Change or drop --pin.`
  }
  if (err instanceof MissingRequiredClientCapabilityError) {
    const capabilities = Object.keys(err.requiredCapabilities)
    const detail = capabilities.length > 0 ? ` (${capabilities.join(', ')})` : ''
    return `The server requires a client capability this CLI did not declare${detail}.`
  }
  if (err instanceof ProtocolError && err.code === HEADER_MISMATCH_CODE) {
    return `The server rejected the request. The protocol version header does not match the request body.`
  }
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
