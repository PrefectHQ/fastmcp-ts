import { defineCommand } from 'citty'
import { spawn } from 'node:child_process'
import { parseFileSpec } from '../../utils/file-spec.js'
import { cliError, formatError } from '../../utils/error.js'
import { log } from '../../ui/output.js'
import { theme } from '../../ui/theme.js'
import { symbols } from '../../ui/symbols.js'
import { withSpinner } from '../../ui/spinner.js'

export default defineCommand({
  meta: { name: 'inspector', description: 'Launch the MCP inspector for a server file' },
  args: {
    spec: { type: 'positional', description: 'File spec (e.g. server.ts or server.ts:app)', required: true },
    port: { type: 'string', description: 'Server port', default: '6274' },
    'server-port': { type: 'string', description: 'Run server as subprocess on this port instead of in-process' },
  },
  async run({ args }) {
    let fileSpec
    try {
      fileSpec = parseFileSpec(args.spec)
    } catch (err) {
      cliError(formatError(err))
    }

    // Start the MCP server as a subprocess
    const [cmd, spawnArgs] = fileSpec.isTypeScript
      ? ['npx', ['tsx', fileSpec.filePath]]
      : ['node', [fileSpec.filePath]]

    let serverProcess = spawn(cmd, spawnArgs, {
      env: { ...process.env, MCP_TRANSPORT: 'stdio' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    await withSpinner('Starting server…', () =>
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    )
    log.success('Server started')

    // Launch inspector pointing at the server subprocess
    const inspectorProcess = spawn(
      'npx',
      ['@modelcontextprotocol/inspector', '--server', `node ${fileSpec.filePath}`],
      { stdio: 'inherit', shell: true },
    )

    log.info(`Inspector running — ${theme.url(`http://localhost:${args.port}`)}`)

    const { watch } = await import('chokidar')
    const watcher = watch(fileSpec.filePath, { ignoreInitial: true })

    watcher.on('change', () => {
      process.stderr.write(`${theme.muted(symbols.reload)} File changed, reloading server…\n`)
      serverProcess.kill()
      serverProcess = spawn(cmd, spawnArgs, {
        env: { ...process.env, MCP_TRANSPORT: 'stdio' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    })

    process.on('SIGINT', () => {
      watcher.close()
      serverProcess.kill()
      inspectorProcess.kill()
      process.exit(0)
    })

    await new Promise<void>((resolve) => inspectorProcess.on('exit', resolve))
  },
})
