import { defineCommand } from 'citty'
import { spawn } from 'node:child_process'
import { parseFileSpec } from '../utils/file-spec.js'
import { cliError, formatError } from '../utils/error.js'
import { log } from '../ui/output.js'
import { theme } from '../ui/theme.js'
import { symbols } from '../ui/symbols.js'

function spawnServer(
  filePath: string,
  isTypeScript: boolean,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
  const [cmd, args] = isTypeScript
    ? ['npx', ['tsx', filePath]]
    : ['node', [filePath]]
  return spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['inherit', 'pipe', 'pipe'],
  })
}

export default defineCommand({
  meta: { name: 'run', description: 'Start an MCP server from a file' },
  args: {
    spec: { type: 'positional', description: 'File spec (e.g. server.ts or server.ts:app)', required: true },
    transport: { type: 'string', description: 'Transport type (stdio|http|sse)', default: 'stdio' },
    port: { type: 'string', description: 'HTTP port (for http/sse transports)' },
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
    if (args.port) transportEnv['MCP_PORT'] = args.port

    let child = spawnServer(fileSpec.filePath, fileSpec.isTypeScript, transportEnv)
    let started = false

    function attachHandlers(proc: ReturnType<typeof spawn>): void {
      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        if (!started) {
          started = true
          process.stderr.write(`${theme.success(symbols.success)} Server started\n`)
        }
        process.stdout.write(text)
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        if (!started && (text.includes('listening') || text.includes('started') || text.includes('running'))) {
          started = true
          process.stderr.write(`${theme.success(symbols.success)} Server started\n`)
        }
        process.stderr.write(text)
      })

      proc.on('exit', (code) => {
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
        started = false
        child = spawnServer(fileSpec.filePath, fileSpec.isTypeScript, transportEnv)
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
