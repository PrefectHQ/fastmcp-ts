/**
 * Entrypoint bootstrap — spawned by the CLI (`run`, `inspect`, `list`, `call`,
 * `dev inspector`) instead of the user's server file directly.
 *
 * This mirrors Python FastMCP's `FileSystemSource` entrypoint resolution
 * (`fastmcp/utilities/mcp_server_config/v1/sources/filesystem.py`): import the
 * user's file, resolve a named export (or a factory function that returns a
 * server), and start it. Keeping this in a spawned subprocess (rather than
 * importing the user's file in the CLI's own process) preserves two things the
 * existing CLI already relies on: `tsx` transpilation for TypeScript files, and
 * process isolation so a crashing user server doesn't take down the CLI.
 *
 * Contract (set by the parent CLI process via environment variables):
 *   - FASTMCP_ENTRYPOINT_FILE: absolute path to the user's server file (required)
 *   - FASTMCP_ENTRYPOINT_EXPORT: export name to resolve. Omitted when the user
 *     didn't specify one, in which case a conventional name is auto-detected.
 *
 * Resolution order when FASTMCP_ENTRYPOINT_EXPORT is not set:
 *   `default`, `mcp`, `server`, `app` — the first of these that is already a
 *   FastMCP instance wins. Auto-detection deliberately does NOT call factory
 *   functions (mirroring Python FastMCP's `_find_server_object`, which only
 *   resolves factories for an explicit entrypoint) — invoking an arbitrary
 *   exported function as a side effect of guessing a name would be surprising,
 *   and a name match that isn't a FastMCP instance is skipped in favor of the
 *   next candidate rather than committing to it. Factory functions are only
 *   resolved when the export name is given explicitly (`file:export` or
 *   `--export`).
 *
 * Backwards compatibility: if no explicit export was requested and none of the
 * conventional names resolve to a valid entrypoint, this script assumes the
 * file already started its own server via top-level side effects (the
 * historical fastmcp-ts contract, e.g. `server.run()` at module scope) and
 * exits without error. An explicit export request that can't be resolved is
 * always a hard error.
 */

import { pathToFileURL } from 'node:url'

const AUTO_DETECT_NAMES = ['default', 'mcp', 'server', 'app']

interface RunnableFastMCP {
  run(): Promise<void>
  isRunning: boolean
  address: { host: string; port: number; path: string } | null
}

function isFastMCPInstance(value: unknown): value is RunnableFastMCP {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['run'] === 'function' &&
    typeof obj['tool'] === 'function' &&
    typeof obj['resource'] === 'function' &&
    typeof obj['prompt'] === 'function' &&
    typeof obj['connect'] === 'function'
  )
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function fail(message: string): never {
  console.error(`fastmcp: ${message}`)
  process.exit(1)
}

async function resolveFactory(
  value: unknown,
  exportName: string,
  filePath: string,
): Promise<unknown> {
  if (typeof value !== 'function') return value
  try {
    return await (value as () => unknown)()
  } catch (err) {
    fail(
      `Failed to call entrypoint factory "${exportName}" in ${filePath}: ` +
        (err instanceof Error ? err.message : String(err)),
    )
  }
}

async function main(): Promise<void> {
  const filePath = process.env['FASTMCP_ENTRYPOINT_FILE']
  if (!filePath) {
    fail('internal error: FASTMCP_ENTRYPOINT_FILE was not set for the entrypoint bootstrap')
  }

  const explicitExport = process.env['FASTMCP_ENTRYPOINT_EXPORT']

  let mod: Record<string, unknown>
  try {
    mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>
  } catch (err) {
    fail(
      `Failed to load entrypoint file "${filePath}": ` +
        (err instanceof Error ? (err.stack ?? err.message) : String(err)),
    )
  }

  let resolved: RunnableFastMCP | undefined

  if (explicitExport) {
    if (!(explicitExport in mod)) {
      const available = Object.keys(mod).filter((k) => k !== '__esModule')
      fail(
        `Entrypoint export "${explicitExport}" not found in ${filePath}.` +
          (available.length > 0
            ? ` Available exports: ${available.join(', ')}.`
            : ' The file has no exports.'),
      )
    }
    const target = await resolveFactory(mod[explicitExport], explicitExport, filePath)
    if (!isFastMCPInstance(target)) {
      fail(
        `Entrypoint export "${explicitExport}" in ${filePath} is not a FastMCP server ` +
          `(or a function that returns one). Got ${describe(target)}.`,
      )
    }
    resolved = target
  } else {
    for (const name of AUTO_DETECT_NAMES) {
      if (!(name in mod)) continue
      const candidate = mod[name]
      // Only a direct FastMCP instance is auto-detected — a name match that
      // isn't one (including a function, which would require calling it) is
      // skipped in favor of the next conventional name rather than erroring
      // or invoking it speculatively.
      if (isFastMCPInstance(candidate)) {
        resolved = candidate
        break
      }
    }
    if (resolved === undefined) {
      // No conventional export resolved to a FastMCP instance. Assume this is
      // a legacy self-running file (it started its own server via top-level
      // side effects when imported above) and exit quietly.
      return
    }
  }

  if (resolved.isRunning) {
    // The file already started this server itself (e.g. a top-level
    // `server.run()` call) before we got a chance to. Don't start it twice.
    return
  }

  await resolved.run()

  // Mirrors the "listening on <url>" line the raw-SDK CLI test fixtures print
  // themselves — FastMCP's own run() doesn't emit a startup banner, but the
  // CLI's `run` command watches stderr for this text to detect a successful
  // HTTP start (see spawnServer()'s "started" detection in commands/run.ts).
  if (resolved.address) {
    const { host, port, path } = resolved.address
    process.stderr.write(`listening on http://${host}:${port}${path}\n`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
