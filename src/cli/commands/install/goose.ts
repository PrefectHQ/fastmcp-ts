import { defineCommand } from 'citty'
import { getConfigPaths } from '../../utils/config-paths.js'
import { installServer, parseArgList, parseEnvMap, type ServerEntry } from './shared.js'

export default defineCommand({
  meta: { name: 'goose', description: 'Install MCP server into Goose (~/.config/goose/config.yaml)' },
  args: {
    name: { type: 'positional', description: 'Server name', required: true },
    command: { type: 'positional', description: 'Command to run the server', required: true },
    args: { type: 'string', description: 'Space-separated server args (quoted)' },
    env: { type: 'string', description: 'Comma-separated KEY=VALUE env vars' },
    force: { type: 'boolean', description: 'Overwrite existing entry without prompting', default: false },
  },
  async run({ args }) {
    const target = getConfigPaths()['goose']!
    await installServer({
      configPath: target.path,
      format: target.format,
      force: args.force,
      configSection: 'extensions',
      configWriter: (config: Record<string, unknown>, entry: ServerEntry) => {
        if (!config['extensions']) config['extensions'] = {}
        ;(config['extensions'] as Record<string, unknown>)[entry.name] = {
          cmd: entry.command,
          ...(entry.args?.length ? { args: entry.args } : {}),
          ...(entry.env ? { env: entry.env } : {}),
          enabled: true,
          type: 'stdio',
        }
      },
      entry: {
        name: args.name,
        command: args.command,
        args: args.args ? parseArgList(args.args) : undefined,
        env: args.env ? parseEnvMap(args.env) : undefined,
      },
    })
  },
})
