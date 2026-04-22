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

export function parseArgList(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean)
}

export function parseEnvMap(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw.split(',').map((kv) => {
      const i = kv.indexOf('=')
      return i === -1 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]
    }),
  )
}

function ensureDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

type InstallCtx = {
  config: Record<string, unknown>
  exists: boolean
  overwrite: boolean
}

export async function installServer(opts: {
  configPath: string
  format: ConfigFormat
  entry: ServerEntry
  force?: boolean
  configSection?: string
  configWriter?: (config: Record<string, unknown>, entry: ServerEntry) => void
}): Promise<void> {
  const { configPath, format, entry } = opts
  const configSection = opts.configSection ?? 'mcpServers'

  const tasks = new Listr<InstallCtx>(
    [
      {
        title: 'Resolving config file',
        task: async (ctx) => {
          ctx.exists = existsSync(configPath)
          if (!ctx.exists) {
            ensureDir(configPath)
            ctx.config = {}
          } else {
            try {
              ctx.config = (readConfig(configPath, format) as Record<string, unknown>) ?? {}
            } catch {
              throw new Error(`Could not parse ${configPath} — is it valid ${format.toUpperCase()}?`)
            }
          }
        },
      },
      {
        title: 'Checking for existing entry',
        task: async (ctx, task) => {
          const section = ctx.config[configSection] as Record<string, unknown> | undefined
          if (section?.[entry.name]) {
            if (opts.force) {
              ctx.overwrite = true
              return
            }
            if (!process.stdin.isTTY || process.env['CI']) {
              throw new Error(`Server "${entry.name}" already exists. Use --force to overwrite.`)
            }
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
        skip: (ctx) => !ctx.overwrite,
        task: async (ctx) => {
          if (opts.configWriter) {
            opts.configWriter(ctx.config, entry)
          } else {
            if (!ctx.config[configSection]) ctx.config[configSection] = {}
            ;(ctx.config[configSection] as Record<string, unknown>)[entry.name] = {
              command: entry.command,
              ...(entry.args ? { args: entry.args } : {}),
              ...(entry.env ? { env: entry.env } : {}),
            }
          }
          writeConfig(configPath, ctx.config, format)
        },
      },
      {
        title: 'Verifying config',
        skip: (ctx) => !ctx.overwrite,
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
