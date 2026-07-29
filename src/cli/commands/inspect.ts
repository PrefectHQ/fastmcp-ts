import { defineCommand } from 'citty'
import { parseFileSpec } from '../utils/file-spec.js'
import { connectClient } from '../utils/connect.js'
import { resolveAuth } from '../utils/auth.js'
import { buildFastmcpManifest } from '../utils/manifest.js'
import { withSpinner } from '../ui/spinner.js'
import { output, setJsonMode } from '../ui/format.js'
import { log } from '../ui/output.js'
import { renderTable } from '../ui/table.js'
import { cliError, formatError, EXIT } from '../utils/error.js'

declare const __FASTMCP_VERSION__: string
declare const __MCP_SDK_VERSION__: string

export default defineCommand({
  meta: { name: 'inspect', description: 'Inspect tools, resources, and prompts from an MCP server' },
  args: {
    url: { type: 'string', description: 'Server URL' },
    command: { type: 'string', description: 'stdio server command' },
    file: { type: 'string', description: 'Server file (e.g. server.ts)' },
    export: { type: 'string', description: 'Named export to resolve (e.g. server); overrides file:export syntax' },
    auth: { type: 'string', description: 'Bearer token' },
    json: { type: 'boolean', description: 'Output JSON', default: false },
    format: { type: 'string', description: 'Output format: fastmcp (the snake_case manifest the Python FastMCP CLI emits for --format fastmcp). Implies JSON output.' },
    modern: { type: 'boolean', description: 'Turn on version negotiation for stdio and in-process connections', default: false },
    pin: { type: 'string', description: 'Pin the protocol era to this revision (e.g. 2026-07-28)' },
  },
  async run({ args }) {
    if (args.format !== undefined && args.format !== 'fastmcp') {
      cliError(`Unknown format "${args.format}". Supported formats: fastmcp`)
    }
    if (args.json || args.format) setJsonMode(true)
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

    const era = { modern: args.modern, pin: args.pin }

    let client
    try {
      client = await withSpinner('Inspecting server…', () =>
        connectClient(mode, authObj, era),
      )
    } catch (err) {
      cliError(formatError(err), { code: EXIT.CONNECTION })
    }

    try {
      if (args.format === 'fastmcp') {
        const [tools, resources, templates, prompts] = await Promise.all([
          client.listTools().catch(() => [] as Awaited<ReturnType<typeof client.listTools>>),
          client.listResources().catch(() => [] as Awaited<ReturnType<typeof client.listResources>>),
          client.listResourceTemplates().catch(() => [] as Awaited<ReturnType<typeof client.listResourceTemplates>>),
          client.listPrompts().catch(() => [] as Awaited<ReturnType<typeof client.listPrompts>>),
        ])

        const manifest = buildFastmcpManifest({
          serverInfo: client.getServerInfo(),
          instructions: client.getInstructions(),
          capabilities: client.getServerCapabilities(),
          // A --file entrypoint is a FastMCP server (Python generation 2, the
          // only case Python's inspect supports); over --url/--command the
          // generation is unknowable from the wire.
          generation: mode.kind === 'inprocess' ? 2 : null,
          fastmcpVersion: __FASTMCP_VERSION__,
          mcpVersion: __MCP_SDK_VERSION__,
          tools,
          prompts,
          resources,
          templates,
        })

        output(manifest, () => {})
        return
      }

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
