import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { Listr } from 'listr2'
import { confirm } from '@clack/prompts'
import { readConfig, writeConfig } from '../../utils/config-paths.js'
import type { ConfigFormat } from '../../utils/config-paths.js'
import { cliError } from '../../utils/error.js'

export interface ServerEntry {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers?: Record<string, unknown>
}

function ensureDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export async function installServer(opts: {
  configPath: string
  format: ConfigFormat
  entry: ServerEntry
}): Promise<void> {
  const { configPath, format, entry } = opts

  const tasks = new Listr(
    [
      {
        title: 'Resolving config file',
        task: async (ctx: { config: McpConfig; exists: boolean }) => {
          ctx.exists = existsSync(configPath)
          if (!ctx.exists) {
            ensureDir(configPath)
            ctx.config = { mcpServers: {} }
          } else {
            try {
              ctx.config = (readConfig(configPath, format) as McpConfig) ?? { mcpServers: {} }
              if (!ctx.config.mcpServers) ctx.config.mcpServers = {}
            } catch {
              throw new Error(`Could not parse ${configPath} — is it valid ${format.toUpperCase()}?`)
            }
          }
        },
      },
      {
        title: 'Checking for existing entry',
        task: async (ctx: { config: McpConfig; exists: boolean; overwrite: boolean }, task) => {
          if (ctx.config.mcpServers?.[entry.name]) {
            const overwrite = await confirm({
              message: `Server "${entry.name}" already exists. Overwrite?`,
            })
            if (!overwrite || typeof overwrite !== 'boolean') {
              task.skip('Skipped — entry unchanged')
              ctx.overwrite = false
              return
            }
          }
          ctx.overwrite = true
        },
      },
      {
        title: 'Writing config',
        skip: (ctx: { overwrite: boolean }) => !ctx.overwrite,
        task: async (ctx: { config: McpConfig }) => {
          const serverEntry: Record<string, unknown> = {
            command: entry.command,
            ...(entry.args ? { args: entry.args } : {}),
            ...(entry.env ? { env: entry.env } : {}),
          }
          ctx.config.mcpServers![entry.name] = serverEntry
          writeConfig(configPath, ctx.config, format)
        },
      },
      {
        title: 'Verifying config',
        skip: (ctx: { overwrite: boolean }) => !ctx.overwrite,
        task: async () => {
          try {
            readConfig(configPath, format)
          } catch {
            throw new Error(`Config verification failed — ${configPath} may be malformed`)
          }
        },
      },
    ],
    { rendererOptions: { collapseErrors: false } },
  )

  try {
    await tasks.run()
  } catch (err) {
    cliError(err instanceof Error ? err.message : String(err))
  }
}
