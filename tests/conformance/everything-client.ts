/**
 * Conformance fixture — the "everything client".
 *
 * Driven by the official MCP conformance suite in *client* mode:
 *   npx @modelcontextprotocol/conformance client \
 *     --command "npx tsx tests/conformance/everything-client.ts"
 *
 * Harness contract (verified against @modelcontextprotocol/conformance 0.1.16 —
 * `dist/index.js` fn `vn`, and README "Client Testing"):
 *   - The framework spawns `--command` with a shell and APPENDS the per-scenario
 *     server URL as the LAST argument. So the URL is `process.argv.at(-1)`.
 *   - `MCP_CONFORMANCE_SCENARIO` env var = the scenario name.
 *   - `MCP_CONFORMANCE_CONTEXT` env var = a JSON object `{ name, ...ctx }` for
 *     scenarios that need extra context (e.g. OAuth). Read defensively.
 *   - There is NO `MCP_CONFORMANCE_PROTOCOL_VERSION` in 0.1.16 (the W9 plan text
 *     named it from pre-release docs; the shipped tool does not set it). We read
 *     it anyway so the fixture is forward-compatible if a later tool version adds it.
 *
 * The client registers sampling + elicitation handlers so server-driven round
 * trips (MRTR / legacy sampling + elicitation) resolve, then drives the tool
 * surface the client scenarios exercise (initialize handshake on connect, plus
 * tools/list + tools/call).
 */
import { Client } from '../../src/client/index.js'
import type {
  SamplingHandler,
  ElicitationHandler,
  CreateMessageRequestParams,
  ElicitRequestParams,
  AnySamplingResult,
  Tool,
} from '../../src/client/index.js'

// --- Harness inputs ------------------------------------------------------
const serverUrl = process.argv[process.argv.length - 1]
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '(none)'
const protocolVersion = process.env.MCP_CONFORMANCE_PROTOCOL_VERSION

// 2026-07-28 selects the modern era (auto-negotiate, fall back to legacy);
// anything else keeps the default legacy handshake. The conformance test
// servers (0.1.16) speak 2025-era, so this resolves to legacy in practice.
const versionNegotiation =
  protocolVersion === '2026-07-28' ? ({ mode: 'auto' } as const) : undefined

// --- Client-side request handlers ---------------------------------------

// Answers server-initiated sampling requests with a fixed completion.
const sampling: SamplingHandler = (_params: CreateMessageRequestParams): AnySamplingResult => ({
  role: 'assistant',
  content: { type: 'text', text: 'This is a test response from the everything-client' },
  model: 'everything-client-model',
  stopReason: 'endTurn',
})

// Answers server-initiated elicitation requests by accepting with values.
// Applies each field's schema `default` when present (SEP-1034 default
// handling); otherwise supplies a type-appropriate value so required fields
// are satisfied.
const elicitation: ElicitationHandler = (params: ElicitRequestParams) => {
  // ElicitRequestParams is a union (form vs. URL elicitation); only the form
  // variant carries requestedSchema.
  const requested =
    'requestedSchema' in params
      ? (params.requestedSchema as { properties?: Record<string, Record<string, unknown>> } | undefined)
      : undefined
  const properties = requested?.properties ?? {}
  const content: Record<string, string | number | boolean> = {}
  for (const [key, def] of Object.entries(properties)) {
    content[key] = 'default' in def ? (def.default as string | number | boolean) : valueForSchema(def)
  }
  return { action: 'accept', content }
}

/** Produces a type-appropriate value for an elicitation field that has no default. */
function valueForSchema(def: Record<string, unknown>): string | number | boolean {
  if (Array.isArray(def.enum) && def.enum.length > 0) return def.enum[0] as string
  switch (def.type) {
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return true
    default:
      return 'test'
  }
}

/** Builds a minimal valid arguments object for a tool from its JSON Schema. */
function argsForTool(tool: Tool): Record<string, unknown> {
  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  const properties = schema.properties ?? {}
  const required = schema.required ?? Object.keys(properties)
  const args: Record<string, unknown> = {}
  for (const key of required) {
    const def = properties[key] ?? {}
    args[key] = valueForSchema(def)
  }
  return args
}

// --- Drive the scenario --------------------------------------------------
async function main(): Promise<void> {
  const client = new Client(serverUrl, {
    handlers: { sampling, elicitation },
    ...(versionNegotiation ? { versionNegotiation } : {}),
  })

  // connect() performs the initialize handshake (the `initialize` scenario).
  await client.connect()

  // Exercise the tool surface: list, then call each tool with synthesized
  // arguments. This drives `tools_call` (add_numbers), the elicitation- and
  // reconnection-triggering tools, without knowing tool names in advance.
  const tools = await client.listTools()
  for (const tool of tools) {
    try {
      // callToolRaw does not throw on tool-level errors (isError results are fine).
      await client.callToolRaw(tool.name, argsForTool(tool))
    } catch (err) {
      process.stderr.write(`[everything-client] tool '${tool.name}' failed: ${String(err)}\n`)
    }
  }

  await client.close()
}

main().then(
  () => {
    process.stderr.write(`[everything-client] scenario '${scenario}' completed\n`)
    process.exit(0)
  },
  (err) => {
    process.stderr.write(`[everything-client] scenario '${scenario}' failed: ${String(err)}\n`)
    process.exit(1)
  },
)
