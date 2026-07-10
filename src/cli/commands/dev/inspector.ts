import { defineCommand } from 'citty'
import { spawn } from 'node:child_process'
import { parseFileSpec } from '../../utils/file-spec.js'
import { resolveEntrypointBootstrapPath, buildEntrypointEnv } from '../../utils/entrypoint-bootstrap.js'
import { cliError, formatError } from '../../utils/error.js'
import { log } from '../../ui/output.js'
import { theme } from '../../ui/theme.js'
import { symbols } from '../../ui/symbols.js'
import { withSpinner } from '../../ui/spinner.js'

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

    // Build the server command for the inspector: it spawns the entrypoint
    // bootstrap (tsx for TypeScript, node for JS) rather than the user's file
    // directly, so file:export entrypoint specs resolve the same way `run`
    // and `inspect` do.
    const bootstrapPath = resolveEntrypointBootstrapPath()
    const serverCmd = fileSpec.isTypeScript
      ? `npx tsx ${bootstrapPath}`
      : `node ${bootstrapPath}`

    await withSpinner('Starting inspector…', () =>
      new Promise<void>((resolve) => setTimeout(resolve, 300)),
    )

    const inspectorProcess = spawn(
      'npx',
      ['@modelcontextprotocol/inspector', '--server', serverCmd],
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
