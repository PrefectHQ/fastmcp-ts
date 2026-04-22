import { defineCommand } from 'citty'
import { parseFileSpec } from '../utils/file-spec.js'
import { connectClient } from '../utils/connect.js'
import { withSpinner } from '../ui/spinner.js'
import { output, setJsonMode } from '../ui/format.js'
import { log } from '../ui/output.js'
import { renderTable } from '../ui/table.js'
import { cliError, formatError, EXIT } from '../utils/error.js'

export default defineCommand({
  meta: { name: 'inspect', description: 'Inspect tools, resources, and prompts from a server file' },
  args: {
    spec: { type: 'positional', description: 'File spec (e.g. server.ts or server.ts:app)', required: true },
    json: { type: 'boolean', description: 'Output JSON', default: false },
  },
  async run({ args }) {
    if (args.json) setJsonMode(true)
    let fileSpec
    try {
      fileSpec = parseFileSpec(args.spec)
    } catch (err) {
      cliError(formatError(err))
    }

    let client
    try {
      client = await withSpinner('Inspecting server…', () =>
        connectClient({ kind: 'inprocess', spec: fileSpec }),
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
