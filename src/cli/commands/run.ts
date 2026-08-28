import { defineCommand } from 'citty'
import { spawn } from 'node:child_process'
import { parseFileSpec, type FileSpec } from '../utils/file-spec.js'
import { resolveEntrypointBootstrapPath, buildEntrypointEnv } from '../utils/entrypoint-bootstrap.js'
import { cliError, formatError } from '../utils/error.js'
import { log } from '../ui/output.js'
import { theme } from '../ui/theme.js'
import { symbols } from '../ui/symbols.js'
import { createStartupReporter } from '../ui/startup.js'

/**
 * Whether the startup reporter should animate a spinner for this run.
 *
 * The stdio transport never animates: it is the default transport (see the
 * `transport` arg below and MCP_TRANSPORT's fallback in FastMCP.run), a spawned
 * stdio child never emits any of the reporter's sniff words on stderr (they only
 * ever appear in an HTTP server's "listening" line), and buffering its stderr
 * behind a live spinner would hide all output for the process lifetime on a TTY.
 * `--reload` also disables animation: the reporter re-fires on every restart.
 *
 * `transport` here is always the resolved value — `spawnServer` unconditionally
 * sets the spawned child's MCP_TRANSPORT to it (see transportEnv below),
 * overriding anything already in the shell's environment — so no separate
 * MCP_TRANSPORT lookup is needed.
 */
export function shouldAnimateStartup(transport: string, reload: boolean): boolean {
  return transport !== 'stdio' && !reload
}

function spawnServer(
  spec: FileSpec,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
  const bootstrapPath = resolveEntrypointBootstrapPath()
  const [cmd, args] = spec.isTypeScript
    ? ['npx', ['tsx', bootstrapPath]]
    : ['node', [bootstrapPath]]
  return spawn(cmd, args, {
    env: { ...process.env, ...buildEntrypointEnv(spec), ...env },
    stdio: ['inherit', 'pipe', 'pipe'],
  })
}

export default defineCommand({
  meta: { name: 'run', description: 'Start an MCP server from a file' },
  args: {
    spec: { type: 'positional', description: 'File spec (e.g. server.ts or server.ts:app)', required: true },
    transport: { type: 'string', description: 'Transport type (stdio|http|sse)', default: 'stdio' },
    host: { type: 'string', description: 'HTTP host to bind to (for http transport)' },
    port: { type: 'string', description: 'HTTP port (for http/sse transports)' },
    path: { type: 'string', description: 'HTTP path to serve on (for http transport)' },
    reload: { type: 'boolean', description: 'Restart on file change', default: false },
  },
  async run({ args }) {
    let fileSpec
    try {
      fileSpec = parseFileSpec(args.spec)
    } catch (err) {
      cliError(formatError(err))
    }

    const transportEnv: Record<string, string> = {
      MCP_TRANSPORT: args.transport,
    }
    if (args.host) transportEnv['MCP_HOST'] = args.host
    if (args.port) transportEnv['MCP_PORT'] = args.port
    if (args.path) transportEnv['MCP_PATH'] = args.path

    let child = spawnServer(fileSpec, transportEnv)

    function attachHandlers(proc: ReturnType<typeof spawn>): void {
      const reporter = createStartupReporter({ animate: shouldAnimateStartup(args.transport, args.reload) })

      proc.stdout?.on('data', (chunk: Buffer) => {
        reporter.onStdout(chunk.toString())
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        reporter.onStderr(chunk.toString())
      })

      proc.on('exit', (code) => {
        if (!reporter.done) reporter.fail()
        if (code !== null && code !== 0 && !args.reload) {
          process.exit(code)
        }
      })
    }

    attachHandlers(child)

    if (args.reload) {
      const { watch } = await import('chokidar')
      const watcher = watch(fileSpec.filePath, { ignoreInitial: true })

      watcher.on('change', () => {
        process.stderr.write(`${theme.muted(symbols.reload)} Reloading…\n`)
        child.kill()
        child = spawnServer(fileSpec, transportEnv)
        attachHandlers(child)
      })
    }

    await new Promise<void>((_, reject) => {
      process.on('SIGINT', () => {
        child.kill()
        process.exit(0)
      })
      process.on('SIGTERM', () => {
        child.kill()
        process.exit(0)
      })
      child.on('error', reject)
    })
  },
})
