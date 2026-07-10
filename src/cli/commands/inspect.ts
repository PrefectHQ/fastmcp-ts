import { defineCommand } from 'citty'
import { parseFileSpec } from '../utils/file-spec.js'
import { connectClient } from '../utils/connect.js'
import { resolveAuth } from '../utils/auth.js'
import { withSpinner } from '../ui/spinner.js'
import { output, setJsonMode } from '../ui/format.js'
import { log } from '../ui/output.js'
import { renderTable } from '../ui/table.js'
import { cliError, formatError, EXIT } from '../utils/error.js'

export default defineCommand({
  meta: { name: 'inspect', description: 'Inspect tools, resources, and prompts from an MCP server' },
  args: {
    url: { type: 'string', description: 'Server URL' },
    command: { type: 'string', description: 'stdio server command' },
    file: { type: 'string', description: 'Server file (e.g. server.ts)' },
    export: { type: 'string', description: 'Named export to resolve (e.g. server); overrides file:export syntax' },
    auth: { type: 'string', description: 'Bearer token' },
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
      client = await withSpinner('Inspecting server…', () =>
        connectClient(mode, authObj),
      )
    } catch (err) {
      cliError(formatError(err), { code: EXIT.CONNECTION })
    }

    try {
      const [tools, resources, prompts] = await Promise.all([
        client.listTools().catch(() => [] as Awaited<ReturnType<typeof client.listTools>>),
        client.listResources().catch(() => [] as Awaited<ReturnType<typeof client.listResources>>),
        client.listPrompts().catch(() => [] as Awaited<ReturnType<typeof client.listPrompts>>),
      ])

      const data = { tools, resources, prompts }

      output(data, ({ tools, resources, prompts }) => {
        log.section(`Tools (${tools.length})`)
        renderTable(
          ['Name', 'Description'],
          tools.map((t) => [t.name, t.description ?? '']),
          { emptyMessage: 'No tools registered.' },
        )

        log.section(`Resources (${resources.length})`)
        renderTable(
          ['URI', 'Description'],
          resources.map((r) => [r.uri, r.description ?? '']),
          { emptyMessage: 'No resources registered.' },
        )

        log.section(`Prompts (${prompts.length})`)
        renderTable(
          ['Name', 'Description'],
          prompts.map((p) => [p.name, p.description ?? '']),
          { emptyMessage: 'No prompts registered.' },
        )
      })
    } finally {
      await client.close().catch(() => {})
    }
  },
})
