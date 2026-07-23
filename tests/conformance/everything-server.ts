/**
 * Conformance fixture — the "everything server".
 *
 * A FastMCP server (this repo's `src/`) that implements every capability the
 * official MCP conformance suite exercises in *server* mode
 * (`npx @modelcontextprotocol/conformance server`). Each section below maps to a
 * group of conformance scenarios; the tool / resource / prompt *names* and the
 * exact result shapes are dictated by the scenario contract (each scenario embeds
 * its "Server Implementation Requirements" in its description — run
 * `npx @modelcontextprotocol/conformance@0.1.16 list --server` and inspect a
 * scenario to see them).
 *
 * The server is dual-era by construction (W1's hybrid HTTP router): the same
 * fixture answers both the modern 2026-07-28 era and the 2025 legacy era. The
 * conformance tool (0.1.16) connects as a 2025-11-25 client, so these scenarios
 * exercise the legacy era.
 *
 * DEFERRED — the `io.modelcontextprotocol/tasks` extension is NOT exercised here.
 * Tasks are deferred post-1.0 (MIGRATION-PLAN-1.0.md §4 W5); the W9 plan text
 * predates that deferral. No tasks tool/resource is registered.
 *
 * Run it straight from source, no build:
 *   PORT=39750 npx tsx tests/conformance/everything-server.ts
 * It prints `listening on http://127.0.0.1:<port>/mcp` once ready.
 */
import {
  FastMCP,
  Image,
  ToolResult,
  ResourceResult,
  PromptResult,
  FastMCPApp,
  Column,
  Text,
  Badge,
  Button,
} from '../../src/server/index.js'
import type { ElicitationSchema } from '../../src/server/index.js'
import { z } from 'zod'

// --- Test assets ---------------------------------------------------------
// A 1x1 red PNG and a minimal (silent) 16-bit mono WAV, base64-encoded. The
// conformance image/audio scenarios only check the content block shape and
// mimeType, so a byte-minimal-but-valid asset is all that is needed.
const PNG_1x1_RED =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const WAV_SILENCE = 'UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const server = new FastMCP({ name: 'fastmcp-everything', version: '1.0.0' })

// =========================================================================
// Tools — content types
// =========================================================================

// tools-call-simple-text
server.tool(
  { name: 'test_simple_text', description: 'Returns a simple text content block.' },
  async () => 'This is a simple text response for testing.',
)

// tools-call-image — the `Image` helper base64-encodes the buffer into an image block.
server.tool(
  { name: 'test_image_content', description: 'Returns an image content block.' },
  async () => new Image(Buffer.from(PNG_1x1_RED, 'base64'), 'image/png'),
)

// tools-call-audio — audio blocks have no dedicated helper, so use the ToolResult escape hatch.
server.tool(
  { name: 'test_audio_content', description: 'Returns an audio content block.' },
  async () => new ToolResult({ content: [{ type: 'audio', data: WAV_SILENCE, mimeType: 'audio/wav' }] }),
)

// tools-call-embedded-resource
server.tool(
  { name: 'test_embedded_resource', description: 'Returns an embedded resource content block.' },
  async () =>
    new ToolResult({
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'test://embedded-resource',
            mimeType: 'text/plain',
            text: 'This is an embedded resource content.',
          },
        },
      ],
    }),
)

// tools-call-mixed-content
server.tool(
  { name: 'test_multiple_content_types', description: 'Returns text, image, and embedded-resource content blocks.' },
  async () =>
    new ToolResult({
      content: [
        { type: 'text', text: 'Multiple content types test:' },
        { type: 'image', data: PNG_1x1_RED, mimeType: 'image/png' },
        {
          type: 'resource',
          resource: {
            uri: 'test://mixed-content-resource',
            mimeType: 'application/json',
            text: JSON.stringify({ test: 'data', value: 123 }),
          },
        },
      ],
    }),
)

// =========================================================================
// Tools — logging, errors, progress
// =========================================================================

// tools-call-with-logging — emits three info-level log messages during execution.
server.tool(
  { name: 'test_tool_with_logging', description: 'Emits log notifications during execution.' },
  async () => {
    const ctx = server.getContext()
    await ctx.info('Tool execution started')
    await sleep(50)
    await ctx.info('Tool processing data')
    await sleep(50)
    await ctx.info('Tool execution completed')
    return 'Tool with logging executed.'
  },
)

// tools-call-error — reports a tool-level error (isError: true), not a protocol error.
server.tool(
  { name: 'test_error_handling', description: 'Always returns a tool-level error result.' },
  async () =>
    new ToolResult({
      isError: true,
      content: [{ type: 'text', text: 'This tool intentionally returns an error for testing' }],
    }),
)

// tools-call-with-progress — reportProgress is a no-op unless the request carried a progressToken.
server.tool(
  { name: 'test_tool_with_progress', description: 'Reports progress notifications during execution.' },
  async () => {
    const ctx = server.getContext()
    await ctx.reportProgress(0, 100)
    await sleep(50)
    await ctx.reportProgress(50, 100)
    await sleep(50)
    await ctx.reportProgress(100, 100)
    return 'Tool with progress executed.'
  },
)

// =========================================================================
// Tools — sampling and elicitation (server -> client round trips)
// =========================================================================

// tools-call-sampling — asks the client's LLM to complete a prompt.
server.tool(
  {
    name: 'test_sampling',
    description: 'Requests an LLM completion from the client via sampling.',
    input: z.object({ prompt: z.string() }),
  },
  async ({ prompt }) => {
    const ctx = server.getContext()
    const result = await ctx.sample({
      messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
      maxTokens: 100,
    })
    const text = result.content.type === 'text' ? result.content.text : ''
    return `LLM response: ${text}`
  },
)

// tools-call-elicitation — asks the client to collect user input via a form.
server.tool(
  {
    name: 'test_elicitation',
    description: 'Requests user input from the client via elicitation.',
    input: z.object({ message: z.string() }),
  },
  async ({ message }) => {
    const ctx = server.getContext()
    const result = await ctx.elicit(message, {
      type: 'object',
      properties: {
        username: { type: 'string', description: "User's response" },
        email: { type: 'string', description: "User's email address" },
      },
      required: ['username', 'email'],
    })
    return `User response: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`
  },
)

// elicitation-sep1034-defaults / elicitation-sep1330-enums —
// These 2025-11-25 scenarios drive elicitation with schema features (per-field
// defaults; enum/oneOf/array variants) that fastmcp's simplified public
// `ElicitationSchema` type deliberately does not surface. The runtime path
// forwards `requestedSchema` verbatim, so a richer object works over the wire —
// we build it as a plain object and cast past the simplified type. The cast is
// the one concession the current public API forces for these scenarios.
server.tool(
  { name: 'test_elicitation_sep1034_defaults', description: 'Elicits input with per-field default values (SEP-1034).' },
  async () => {
    const ctx = server.getContext()
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name', default: 'John Doe' },
        age: { type: 'integer', description: 'Age', default: 30 },
        score: { type: 'number', description: 'Score', default: 95.5 },
        status: { type: 'string', enum: ['active', 'inactive', 'pending'], default: 'active' },
        verified: { type: 'boolean', description: 'Verified', default: true },
      },
    }
    const result = await ctx.elicit('Provide your details', schema as unknown as ElicitationSchema)
    return `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`
  },
)

server.tool(
  { name: 'test_elicitation_sep1330_enums', description: 'Elicits input with all enum schema variants (SEP-1330).' },
  async () => {
    const ctx = server.getContext()
    const schema = {
      type: 'object',
      properties: {
        untitledSingle: { type: 'string', enum: ['option1', 'option2', 'option3'] },
        titledSingle: {
          type: 'string',
          oneOf: [
            { const: 'value1', title: 'First Option' },
            { const: 'value2', title: 'Second Option' },
          ],
        },
        legacyEnum: {
          type: 'string',
          enum: ['opt1', 'opt2', 'opt3'],
          enumNames: ['Option One', 'Option Two', 'Option Three'],
        },
        untitledMulti: { type: 'array', items: { type: 'string', enum: ['option1', 'option2', 'option3'] } },
        titledMulti: {
          type: 'array',
          items: {
            anyOf: [
              { const: 'value1', title: 'First Choice' },
              { const: 'value2', title: 'Second Choice' },
            ],
          },
        },
      },
    }
    const result = await ctx.elicit('Choose your options', schema as unknown as ElicitationSchema)
    return `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`
  },
)

// =========================================================================
// Tools — JSON Schema 2020-12 preservation (SEP-1613)
// =========================================================================

// json-schema-2020-12 — advertises a tool whose `inputSchema` uses 2020-12
// keywords ($schema, $defs, additionalProperties). An explicit `inputSchema`
// (ToolConfig.inputSchema) is forwarded to clients verbatim, so the keywords
// survive into tools/list unmodified. The handler is never invoked by the test.
server.tool(
  {
    name: 'json_schema_2020_12_tool',
    description: 'Tool with JSON Schema 2020-12 features',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
      properties: {
        name: { type: 'string' },
        address: { $ref: '#/$defs/address' },
      },
      additionalProperties: false,
    },
  },
  async () => 'ok',
)

// =========================================================================
// Tools — structured output
// =========================================================================

// An `output` validator is advertised to clients as `outputSchema`; returning a
// plain object populates both `structuredContent` and a JSON text block. No
// 0.1.16 server scenario exercises structured output, so this tool is
// coverage-only (documentation grade) — kept to cover brief item 1's structured
// output surface.
server.tool(
  {
    name: 'test_structured_output',
    description: 'Returns structured output validated against an output schema.',
    input: z.object({ city: z.string() }),
    output: z.object({ city: z.string(), tempC: z.number(), conditions: z.string() }),
  },
  async ({ city }) => ({ city, tempC: 21, conditions: 'clear' }),
)

// =========================================================================
// Tools — SSE polling (SEP-1699)
// =========================================================================

// server-sse-polling drives a raw POST tools/call for `test_reconnection` and
// inspects the SSE stream (priming event, retry field, mid-call disconnect).
// The tool just needs to exist and return a normal result.
server.tool(
  { name: 'test_reconnection', description: 'Returns a normal result; probed by the SSE polling scenario.' },
  async () => 'Reconnection test completed.',
)

// =========================================================================
// Resources — direct, binary, template
// =========================================================================

// resources-read-text
server.resource(
  { uri: 'test://static-text', name: 'static-text', description: 'A static text resource', mimeType: 'text/plain' },
  () => 'This is the content of the static text resource.',
)

// resources-read-binary — a Buffer return becomes a base64 blob content block.
server.resource(
  { uri: 'test://static-binary', name: 'static-binary', description: 'A static binary resource', mimeType: 'image/png' },
  () => Buffer.from(PNG_1x1_RED, 'base64'),
)

// The resource embedded by test_embedded_resource, also exposed as a direct resource.
server.resource(
  { uri: 'test://embedded-resource', name: 'embedded-resource', description: 'An embeddable text resource', mimeType: 'text/plain' },
  () => new ResourceResult([{ uri: 'test://embedded-resource', mimeType: 'text/plain', text: 'This is an embedded resource content.' }]),
)

// The resource the subscribe/unsubscribe scenarios target.
server.resource(
  { uri: 'test://watched-resource', name: 'watched-resource', description: 'A resource clients can subscribe to', mimeType: 'text/plain' },
  () => 'Watched resource content.',
)

// resources-templates-read — {id} is substituted from the requested URI.
server.resource(
  {
    uri: 'test://template/{id}/data',
    name: 'template-data',
    description: 'A resource template keyed by id',
    mimeType: 'application/json',
  },
  (params) => ({ id: params?.id, templateTest: true, data: `Data for ID: ${params?.id}` }),
)

// =========================================================================
// Prompts
// =========================================================================

// prompts-get-simple
server.prompt(
  { name: 'test_simple_prompt', description: 'A simple prompt with no arguments' },
  () => 'This is a simple prompt for testing.',
)

// prompts-get-with-args — arg1 also carries a completion callback. The
// completion-complete scenario calls
// `complete({ ref: { type: 'ref/prompt', name: 'test_prompt_with_arguments' },
// argument: { name: 'arg1', value: 'test' } })` and asserts `completion.values`
// is an array, so a real completer here exercises the completion/complete path.
server.prompt(
  {
    name: 'test_prompt_with_arguments',
    description: 'A prompt with two required arguments',
    arguments: [
      {
        name: 'arg1',
        description: 'First test argument',
        required: true,
        complete: (value) =>
          ['alpha', 'beta', 'gamma'].filter((v) => v.startsWith(value)),
      },
      { name: 'arg2', description: 'Second test argument', required: true },
    ],
  },
  (args) => `Prompt with arguments: arg1='${args?.arg1}', arg2='${args?.arg2}'`,
)

// prompts-get-embedded-resource
server.prompt(
  {
    name: 'test_prompt_with_embedded_resource',
    description: 'A prompt that embeds a resource',
    arguments: [{ name: 'resourceUri', description: 'URI of the resource to embed', required: true }],
  },
  (args) =>
    new PromptResult([
      {
        role: 'user',
        content: {
          type: 'resource',
          resource: {
            uri: args?.resourceUri ?? 'test://embedded-resource',
            mimeType: 'text/plain',
            text: 'Embedded resource content for testing.',
          },
        },
      },
      { role: 'user', content: { type: 'text', text: 'Please process the embedded resource above.' } },
    ]),
)

// prompts-get-with-image
server.prompt(
  { name: 'test_prompt_with_image', description: 'A prompt that includes an image' },
  () =>
    new PromptResult([
      { role: 'user', content: { type: 'image', data: PNG_1x1_RED, mimeType: 'image/png' } },
      { role: 'user', content: { type: 'text', text: 'Please analyze the image above.' } },
    ]),
)

// =========================================================================
// Apps (W4 extension surface)
// =========================================================================

// A real FastMCPApp: a UI entrypoint tool (backed by a ui:// resource) plus a
// backend tool the UI invokes. Conformance 0.1.16 ships no apps-extension
// scenarios, so the suite does not exercise this today (coverage waits on
// conformance main / the nightly) — it is registered to cover W4's public
// surface at documentation grade.
const dashboardApp = new FastMCPApp({ name: 'dashboard-app' })

dashboardApp.entrypoint(
  { name: 'open_dashboard', description: 'Open the status dashboard UI.' },
  () =>
    Column({}, [
      Text('Everything-server dashboard'),
      Badge('online'),
      Button({ label: 'Refresh', action: dashboardApp.toolRef('refresh_status') }),
    ]),
)

dashboardApp.backendTool(
  { name: 'refresh_status', description: 'Backend action invoked from the dashboard UI.' },
  () => ({ status: 'ok', checkedAt: new Date().toISOString() }),
)

server.addProvider(dashboardApp)

// =========================================================================
// Serve over HTTP (server mode connects via --url)
// =========================================================================
const port = parseInt(process.env.PORT ?? '39750', 10)
await server.run({ transport: 'http', host: '127.0.0.1', port, path: '/mcp' })
if (server.address) {
  // A wrapper waits for this line before starting the conformance run.
  process.stdout.write(`listening on http://127.0.0.1:${server.address.port}/mcp\n`)
}
