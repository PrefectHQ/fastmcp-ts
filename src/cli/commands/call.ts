import { defineCommand } from 'citty'
import { connectClient } from '../utils/connect.js'
import { resolveAuth } from '../utils/auth.js'
import { parseFileSpec } from '../utils/file-spec.js'
import { withSpinner } from '../ui/spinner.js'
import { output, setJsonMode } from '../ui/format.js'
import { log } from '../ui/output.js'
import { theme } from '../ui/theme.js'
import { cliError, formatError, EXIT } from '../utils/error.js'
import { closestMatch } from '../utils/fuzzy.js'

function parseKvArgs(rawArgs: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const arg of rawArgs) {
    const idx = arg.indexOf('=')
    if (idx === -1) {
      result[arg] = true
      continue
    }
    const key = arg.slice(0, idx)
    const raw = arg.slice(idx + 1)
    try {
      result[key] = JSON.parse(raw)
    } catch {
      result[key] = raw
    }
  }
  return result
}

type JsonSchema = { properties?: Record<string, { type?: string | string[] }>; [k: string]: unknown }

// Coerce kv-parsed values to match the declared schema types.
// JSON.parse turns bare "1" into a number; if the schema says string, convert it back.
function coerceToSchema(input: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const props = schema.properties
  if (!props) return input
  const out: Record<string, unknown> = { ...input }
  for (const [key, value] of Object.entries(out)) {
    const prop = props[key]
    if (!prop) continue
    const types = ([] as string[]).concat(prop.type ?? [])
    if (types.includes('string') && typeof value !== 'string') {
      out[key] = String(value)
    } else if (types.includes('number') && typeof value === 'string' && value !== '' && !isNaN(Number(value))) {
      out[key] = Number(value)
    } else if (types.includes('integer') && typeof value === 'string' && value !== '' && Number.isInteger(Number(value))) {
      out[key] = Number(value)
    }
  }
  return out
}

export default defineCommand({
  meta: { name: 'call', description: 'Call a tool, resource, or prompt on an MCP server' },
  args: {
    target: { type: 'positional', description: 'Tool name, resource URI, or prompt name', required: true },
    url: { type: 'string', description: 'Server URL' },
    command: { type: 'string', description: 'stdio server command' },
    file: { type: 'string', description: 'Server file (e.g. server.ts)' },
    auth: { type: 'string', description: 'Bearer token' },
    'input-json': { type: 'string', description: 'Raw JSON input instead of key=value args' },
    json: { type: 'boolean', description: 'Output JSON', default: false },
  },
  async run({ args, rawArgs }) {
    if (args.json) setJsonMode(true)
    if (!args.url && !args.command && !args.file) {
      cliError('Provide --url <url>, --command <cmd>, or --file <file>')
    }

    const authObj = resolveAuth(args.auth)

    let fileSpec
    if (args.file) {
      try {
        fileSpec = parseFileSpec(args.file)
      } catch (err) {
        cliError(formatError(err))
      }
    }

    const mode = args.file
      ? { kind: 'inprocess' as const, spec: fileSpec }
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

    const [tools, resources, prompts] = await Promise.all([
      client.listTools().catch(() => [] as Awaited<ReturnType<typeof client.listTools>>),
      client.listResources().catch(() => [] as Awaited<ReturnType<typeof client.listResources>>),
      client.listPrompts().catch(() => [] as Awaited<ReturnType<typeof client.listPrompts>>),
    ])

    const target = args.target

    const matchedTool = tools.find((t) => t.name === target)
    const matchedResource = resources.find((r) => r.uri === target)
    const matchedPrompt = prompts.find((p) => p.name === target)

    if (!matchedTool && !matchedResource && !matchedPrompt) {
      const allNames = [
        ...tools.map((t) => t.name),
        ...resources.map((r) => r.uri),
        ...prompts.map((p) => p.name),
      ]
      const suggestion = closestMatch(target, allNames)
      cliError(
        `No tool, resource, or prompt named "${target}".`,
        { hint: suggestion ? `Did you mean "${suggestion}"?` : undefined },
      )
    }

    const flagValues = new Set([target, args.url, args.command, args.file, args.auth, args['input-json']].filter(Boolean) as string[])
    const kvRaw = (rawArgs as string[]).filter((a) => !a.startsWith('-') && !flagValues.has(a))
    let input: Record<string, unknown> = args['input-json']
      ? (JSON.parse(args['input-json']) as Record<string, unknown>)
      : parseKvArgs(kvRaw)
    if (matchedTool?.inputSchema) {
      input = coerceToSchema(input, matchedTool.inputSchema as JsonSchema)
    }

    try {
      if (matchedTool) {
        const result = await withSpinner(`Calling ${target}…`, () =>
          client.callTool(target, input),
        )

        output(result, (r) => {
          for (const block of r.content) {
            if (block.type === 'text') {
              log.raw(block.text)
            } else {
              log.raw(JSON.stringify(block, null, 2))
            }
          }
        })
      } else if (matchedResource) {
        const result = await withSpinner(`Reading resource ${target}…`, () =>
          client.readResource(target),
        )

        output(result, (r) => {
          for (const content of r) {
            if ('text' in content) {
              log.raw(content.text as string)
            } else {
              process.stderr.write(theme.muted(`[binary resource, ${content.mimeType ?? 'unknown mime'}]\n`))
            }
          }
        })
      } else if (matchedPrompt) {
        const result = await withSpinner(`Getting prompt ${target}…`, () =>
          client.getPrompt(target, input as Record<string, string>),
        )

        output(result, (r) => {
          for (const msg of r.messages) {
            const role = theme.label(msg.role + ':')
            const content = typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content, null, 2)
            log.raw(`${role} ${content}`)
          }
        })
      }
    } catch (err) {
      cliError(formatError(err), { code: EXIT.SERVER })
    } finally {
      await client.close().catch(() => {})
    }
  },
})
