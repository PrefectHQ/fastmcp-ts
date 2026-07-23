import { defineCommand } from 'citty'
import { spawn } from 'node:child_process'
import { parseFileSpec } from '../../utils/file-spec.js'
import { resolveEntrypointBootstrapPath, buildEntrypointEnv } from '../../utils/entrypoint-bootstrap.js'
import { cliError, formatError } from '../../utils/error.js'
import { log } from '../../ui/output.js'
import { theme } from '../../ui/theme.js'
import { symbols } from '../../ui/symbols.js'
import { withSpinner } from '../../ui/spinner.js'

/**
 * Builds the server command + args the inspector expects as trailing
 * positional arguments — tsx for TypeScript, node for JS — e.g.
 * `['node', '/abs/dist/cli/entrypoint-runtime.cjs']`.
 *
 * The inspector's CLI takes the server's command and args this way
 * (`npx @modelcontextprotocol/inspector node file.js`), not as a single
 * quoted string. Inspector 1.0 repurposed `--server <name>` to select a
 * server from a `--config` file, so passing a command string to `--server`
 * fails outright ("--server requires --config to be specified").
 *
 * The command spawns the entrypoint bootstrap rather than the user's file
 * directly, so `file:export` entrypoint specs resolve the same way `run` and
 * `inspect` do — the user's file travels in the entrypoint env
 * (see `buildEntrypointEnv`), and the runner (tsx vs node) still follows the
 * USER file's type so the bootstrap can import a TypeScript entrypoint.
 */
export function buildInspectorServerArgs(
  fileSpec: { isTypeScript: boolean },
  bootstrapPath: string,
): string[] {
  return fileSpec.isTypeScript ? ['npx', 'tsx', bootstrapPath] : ['node', bootstrapPath]
}

export default defineCommand({
  meta: { name: 'inspector', description: 'Launch the MCP inspector for a server file' },
  args: {
    spec: { type: 'positional', description: 'File spec (e.g. server.ts or server.ts:app)', required: true },
    port: { type: 'string', description: 'Inspector UI port', default: '6274' },
  },
  async run({ args }) {
    let fileSpec
    try {
      fileSpec = parseFileSpec(args.spec)
    } catch (err) {
      cliError(formatError(err))
    }

    const serverArgs = buildInspectorServerArgs(fileSpec, resolveEntrypointBootstrapPath())

    await withSpinner('Starting inspector…', () =>
      new Promise<void>((resolve) => setTimeout(resolve, 300)),
    )

    // Era note: the published inspector bundles the legacy `@modelcontextprotocol/sdk`
    // client (protocol versions up to 2025-11-25), so it cannot negotiate the
    // 2026-07-28 (modern) era. A fastmcp server pins its era per stdio connection,
    // so it still serves the inspector's legacy-era client correctly — the
    // inspector just never exercises the modern era. This is an inspector-side
    // limit, not something this CLI can work around.
    const inspectorProcess = spawn(
      'npx',
      ['@modelcontextprotocol/inspector', ...serverArgs],
      {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, MCP_TRANSPORT: 'stdio', ...buildEntrypointEnv(fileSpec) },
      },
    )

    log.info(`Inspector running — ${theme.url(`http://localhost:${args.port}`)}`)

    const { watch } = await import('chokidar')
    const watcher = watch(fileSpec.filePath, { ignoreInitial: true })

    watcher.on('change', () => {
      process.stderr.write(`${theme.muted(symbols.reload)} File changed, reloading inspector…\n`)
      inspectorProcess.kill()
    })

    process.on('SIGINT', () => {
      watcher.close()
      inspectorProcess.kill()
      process.exit(0)
    })

    await new Promise<void>((resolve) => inspectorProcess.on('exit', resolve))
  },
})
