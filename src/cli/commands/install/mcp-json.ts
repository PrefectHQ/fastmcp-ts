import { defineCommand } from 'citty'
import { getConfigPaths } from '../../utils/config-paths.js'
import { installServer, parseArgList, parseEnvMap } from './shared.js'

export default defineCommand({
  meta: { name: 'mcp-json', description: 'Install MCP server into local mcp.json' },
  args: {
    name: { type: 'positional', description: 'Server name', required: true },
    command: { type: 'positional', description: 'Command to run the server', required: true },
    args: { type: 'string', description: 'Space-separated server args (quoted)' },
    env: { type: 'string', description: 'Comma-separated KEY=VALUE env vars' },
    force: { type: 'boolean', description: 'Overwrite existing entry without prompting', default: false },
  },
  async run({ args }) {
    const target = getConfigPaths()['mcp-json']!
    await installServer({
      configPath: target.path,
      format: target.format,
      force: args.force,
      entry: {
        name: args.name,
        command: args.command,
        args: args.args ? parseArgList(args.args) : undefined,
        env: args.env ? parseEnvMap(args.env) : undefined,
      },
    })
  },
})
