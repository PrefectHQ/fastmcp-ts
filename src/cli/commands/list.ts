import { defineCommand } from 'citty'
import { connectClient } from '../utils/connect.js'
import { resolveAuth } from '../utils/auth.js'
import { parseFileSpec } from '../utils/file-spec.js'
import { withSpinner } from '../ui/spinner.js'
import { output, setJsonMode } from '../ui/format.js'
import { log } from '../ui/output.js'
import { renderTable } from '../ui/table.js'
import { renderSchema } from '../ui/schema.js'
import { cliError, formatError, EXIT } from '../utils/error.js'

export default defineCommand({
  meta: { name: 'list', description: 'List tools, resources, and prompts from an MCP server' },
  args: {
    url: { type: 'string', description: 'Server URL' },
    command: { type: 'string', description: 'stdio server command' },
    file: { type: 'string', description: 'Server file (e.g. server.ts)' },
    export: { type: 'string', description: 'Named export to resolve (e.g. server); overrides file:export syntax' },
    auth: { type: 'string', description: 'Bearer token' },
    resources: { type: 'boolean', description: 'Also list resources', default: false },
    prompts: { type: 'boolean', description: 'Also list prompts', default: false },
    'input-schema': { type: 'boolean', description: 'Expand input schemas', default: false },
    json: { type: 'boolean', description: 'Output JSON', default: false },
  },
  async run({ args }) {
    if (args.json) setJsonMode(true)
    if (!args.url && !args.command && !args.file) {
      cliError('Provide a server URL, --command <cmd>, or --file <file>')
    }

    const authObj = resolveAuth(args.auth)

    let fileSpec
    if (args.file) {
      try {
        fileSpec = parseFileSpec(args.file, args.export)
      } catch (err) {
        cliError(formatError(err))
      }
    }

    const mode = args.file
      ? { kind: 'inprocess' as const, spec: fileSpec! }
      : args.command
        ? { kind: 'stdio' as const, command: args.command }
        : { kind: 'url' as const, url: args.url! }

    let client
    try {
      client = await withSpinner('Connecting to server…', () =>
        connectClient(mode, authObj),
      )
    } catch (err) {
      cliError(formatError(err), { code: EXIT.CONNECTION })
    }

    try {
      const tools = await withSpinner('Fetching tools…', () => client.listTools())
      const resources = args.resources
        ? await withSpinner('Fetching resources…', () => client.listResources())
        : []
      const prompts = args.prompts
        ? await withSpinner('Fetching prompts…', () => client.listPrompts())
        : []

      const data = { tools, resources, prompts }

      output(data, ({ tools, resources, prompts }) => {
        const showInputSchema = args['input-schema']

        log.section(`Tools (${tools.length})`)
        if (showInputSchema) {
          for (const tool of tools) {
            log.kv(tool.name, tool.description ?? '')
            if (tool.inputSchema) {
              process.stderr.write(renderSchema(tool.inputSchema as Parameters<typeof renderSchema>[0], false) + '\n')
            }
          }
        } else {
          renderTable(
            ['Name', 'Description'],
            tools.map((t) => [t.name, t.description ?? '']),
            { emptyMessage: 'No tools.' },
          )
        }

        if (resources.length > 0 || args.resources) {
          log.section(`Resources (${resources.length})`)
          renderTable(
            ['URI', 'Description'],
            resources.map((r) => [r.uri, r.description ?? '']),
            { emptyMessage: 'No resources.' },
          )
        }

        if (prompts.length > 0 || args.prompts) {
          log.section(`Prompts (${prompts.length})`)
          renderTable(
            ['Name', 'Description'],
            prompts.map((p) => [p.name, p.description ?? '']),
            { emptyMessage: 'No prompts.' },
          )
        }
      })
    } finally {
      await client.close().catch(() => {})
    }
  },
})
