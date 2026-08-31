/**
 * Framework logging: the injectable Logger contract, the level gate, and the
 * built-in stderr sink. `resolveLogger` runs once, in the FastMCP constructor,
 * and fails loudly on malformed config (the `resolveCors` precedent).
 *
 * Two invariants:
 * - Every DefaultSink byte goes to stderr. stdout is the stdio protocol
 *   channel and must never carry log output.
 * - An injected logger receives clean (message, meta) values: no ANSI, no
 *   symbols, no "[fastmcp]" prefix. Presentation belongs to DefaultSink only.
 */
import { symbols, theme } from '../shared/terminal'

/** Sink contract for FastMCPOptions.logger. `console` and Winston loggers
 * satisfy it structurally; Pino needs a small adapter (see docs/servers/logging.mdx). */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

const FRAMEWORK_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const

/** Framework-diagnostics level axis. Distinct from the MCP `LogLevel` union
 * (client-facing `ctx.log` levels), which is a separate axis entirely. */
export type FrameworkLogLevel = (typeof FRAMEWORK_LOG_LEVELS)[number]

const LEVEL_ORDER: Record<FrameworkLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 }

function isFrameworkLogLevel(value: unknown): value is FrameworkLogLevel {
  return typeof value === 'string' && (FRAMEWORK_LOG_LEVELS as readonly string[]).includes(value)
}

// Same loud-failure posture as envBool (src/server/env.ts): a malformed ops
// variable must fail at startup, not silently fall back.
function envLogLevel(): FrameworkLogLevel | undefined {
  const raw = process.env['FASTMCP_LOG_LEVEL']
  if (raw === undefined || raw.trim() === '') return undefined
  const normalized = raw.trim().toLowerCase()
  if (!isFrameworkLogLevel(normalized)) {
    throw new Error(
      `[fastmcp] FASTMCP_LOG_LEVEL must be one of debug/info/warn/error/silent (case-insensitive). Received: ${JSON.stringify(raw)}`,
    )
  }
  return normalized
}

export interface BannerFields {
  name: string
  version: string
  transport: 'stdio' | 'http'
  url?: string
}

function formatMetaValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? String(value)
  if (typeof value === 'string') return value
  // A circular or BigInt-bearing meta value must not throw from inside a log
  // call: that would surface as a failure in whatever unrelated code path
  // logged it (for example a custom route's error handler, killing its own
  // 500 response). Fall back to String() rather than let the log call itself
  // become the failure.
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function jsonMeta(meta: Record<string, unknown>): string {
  const plain = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v instanceof Error ? String(v) : v]))
  try {
    return JSON.stringify(plain)
  } catch {
    return String(plain)
  }
}

/** Built-in sink. Pretty mode on a TTY (unless NO_COLOR), plain single-line
 * format otherwise. All output to stderr, by construction. */
export class DefaultSink implements Logger {
  readonly mode: 'pretty' | 'plain'

  constructor(mode?: 'pretty' | 'plain') {
    this.mode = mode ?? (process.stderr.isTTY === true && process.env['NO_COLOR'] === undefined ? 'pretty' : 'plain')
  }

  private write(line: string): void {
    process.stderr.write(`${line}\n`)
  }

  private plainLine(level: FrameworkLogLevel, message: string, meta?: Record<string, unknown>): string {
    const metaStr = meta && Object.keys(meta).length > 0 ? ` ${jsonMeta(meta)}` : ''
    return `[fastmcp] ${level.toUpperCase()} ${message}${metaStr}`
  }

  private prettyMeta(meta?: Record<string, unknown>): string {
    if (!meta || Object.keys(meta).length === 0) return ''
    const pairs = Object.entries(meta).map(([k, v]) => `${k}=${formatMetaValue(v)}`).join(' ')
    return ` ${theme.muted(pairs)}`
  }

  private emit(level: Exclude<FrameworkLogLevel, 'silent'>, message: string, meta?: Record<string, unknown>): void {
    if (this.mode === 'plain') { this.write(this.plainLine(level, message, meta)) ; return }
    switch (level) {
      case 'debug': this.write(theme.muted(`· ${message}`) + this.prettyMeta(meta)); break
      case 'info': this.write(`${theme.muted(symbols.info)} ${message}${this.prettyMeta(meta)}`); break
      case 'warn': this.write(`${theme.warning(symbols.warning)} ${theme.warning(message)}${this.prettyMeta(meta)}`); break
      case 'error': this.write(`${theme.error(symbols.failure)} ${theme.error(message)}${this.prettyMeta(meta)}`); break
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void { this.emit('debug', message, meta) }
  info(message: string, meta?: Record<string, unknown>): void { this.emit('info', message, meta) }
  warn(message: string, meta?: Record<string, unknown>): void { this.emit('warn', message, meta) }
  error(message: string, meta?: Record<string, unknown>): void { this.emit('error', message, meta) }

  /** Startup card (pretty) or single plain info line. Mirrors the CLI's
   * output.kv/section look (src/cli/ui/output.ts). */
  banner(fields: BannerFields): void {
    if (this.mode === 'plain') {
      this.info(`starting ${fields.name} v${fields.version} (${fields.transport})`, fields.url !== undefined ? { url: fields.url } : undefined)
      return
    }
    const kv = (key: string, value: string) => `  ${theme.label(key.padEnd(12))} ${theme.value(value)}`
    const rows = [
      '',
      `  ${theme.primary('FastMCP')}  ${theme.value(fields.name)} ${theme.muted(`v${fields.version}`)}`,
      `  ${theme.muted(symbols.separator)}`,
      kv('transport', fields.transport),
      ...(fields.url !== undefined ? [kv('url', fields.url)] : []),
      '',
    ]
    this.write(rows.join('\n'))
  }

  listening(url: string): void {
    if (this.mode === 'plain') { this.info(`listening on ${url}`) ; return }
    this.write(`${theme.success(symbols.success)} listening on ${theme.url(url)}`)
  }
}

/** Level-gated wrapper around the sink. This is what the framework holds and
 * calls; the gate applies identically to injected and default sinks. */
export class ResolvedLogger {
  constructor(
    private readonly sink: Logger,
    readonly level: FrameworkLogLevel,
  ) {}

  private enabled(level: Exclude<FrameworkLogLevel, 'silent'>): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level]
  }

  // meta stays an omitted argument (not `undefined` passed explicitly) when the
  // caller left it out: a sink like `console` prints a literal "undefined" for a
  // second argument that is present but empty, and console.info/console.debug
  // write to stdout, so a stray argument there is a stdio protocol-safety bug too.
  debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled('debug')) return
    if (meta === undefined) this.sink.debug(message)
    else this.sink.debug(message, meta)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled('info')) return
    if (meta === undefined) this.sink.info(message)
    else this.sink.info(message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled('warn')) return
    if (meta === undefined) this.sink.warn(message)
    else this.sink.warn(message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled('error')) return
    if (meta === undefined) this.sink.error(message)
    else this.sink.error(message, meta)
  }

  /** Server-start card. Pretty DefaultSink renders a banner block;
   * every other sink gets one plain info line. Gated as info. */
  startupBanner(fields: BannerFields): void {
    if (!this.enabled('info')) return
    if (this.sink instanceof DefaultSink) { this.sink.banner(fields) ; return }
    this.info(`starting ${fields.name} v${fields.version} (${fields.transport})`, fields.url !== undefined ? { url: fields.url } : undefined)
  }

  /** Listening confirmation. The word "listening" is load-bearing: the CLI's
   * run command detects a successful start by sniffing stderr for it. */
  listening(url: string): void {
    if (!this.enabled('info')) return
    if (this.sink instanceof DefaultSink) { this.sink.listening(url) ; return }
    this.info(`listening on ${url}`)
  }
}

/** Resolve FastMCPOptions.logger + logLevel. Throws on malformed config so a
 * JS caller fails at construction, for every transport. */
export function resolveLogger(logger: Logger | undefined, logLevel: FrameworkLogLevel | undefined): ResolvedLogger {
  if (logLevel !== undefined && !isFrameworkLogLevel(logLevel)) {
    throw new Error(`Invalid logLevel: must be one of debug/info/warn/error/silent, got: ${JSON.stringify(logLevel)}`)
  }
  if (logger !== undefined) {
    for (const method of ['debug', 'info', 'warn', 'error'] as const) {
      if (typeof (logger as Partial<Logger>)[method] !== 'function') {
        throw new Error(`Invalid logger: must implement debug/info/warn/error methods; missing ${method}()`)
      }
    }
  }
  const level = logLevel ?? envLogLevel() ?? 'info'
  return new ResolvedLogger(logger ?? new DefaultSink(), level)
}
