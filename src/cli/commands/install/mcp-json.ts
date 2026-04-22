import { defineCommand } from 'citty'
import { getConfigPaths } from '../../utils/config-paths.js'
import { installServer } from './shared.js'

export default defineCommand({
  meta: { name: 'mcp-json', description: 'Install MCP server into local mcp.json' },
  args: {
    name: { type: 'positional', description: 'Server name', required: true },
    command: { type: 'positional', description: 'Command to run the server', required: true },
    args: { type: 'string', description: 'Comma-separated args' },
    env: { type: 'string', description: 'KEY=VALUE pairs (comma-separated)' },
  },
  async run({ args }) {
    const target = getConfigPaths()['mcp-json']!
    await installServer({
      configPath: target.path,
      format: target.format,
      entry: {
        name: args.name,
        command: args.command,
        args: args.args ? args.args.split(',') : undefined,
        env: args.env ? Object.fromEntries(args.env.split(',').map((kv) => kv.split('='))) : undefined,
      },
    })
  },
})
