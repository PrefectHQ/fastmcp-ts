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
 *   - `MCP_CONFORMANCE_PROTOCOL_VERSION` is set only by newer tool builds
 *     (conformance main / 0.2.x set it to the scenario's revision, e.g.
 *     `2026-07-28` for the SEP-2243 header scenarios; pinned 0.1.16 does not
 *     set it). We read it so those scenarios negotiate the modern era; when
 *     absent the fixture keeps the legacy handshake.
 *
 * The client registers sampling + elicitation handlers so server-driven round
 * trips (MRTR / legacy sampling + elicitation) resolve, then drives the tool
 * surface the client scenarios exercise (initialize handshake on connect, plus
 * tools/list + tools/call).
 *
 * Two context-driven behaviors extend the base fixture:
 *   - SEP-2243 header scenarios (`http-custom-headers`) hand the client an
 *     explicit `toolCalls` script (exact arguments, including base64-unsafe
 *     values). When present, the fixture drives those exact calls so the SDK
 *     client mirrors `x-mcp-header` tool parameters into `Mcp-Param-*` headers
 *     with the encodings the scenario checks — no product change needed (the
 *     v2 SDK client emits them automatically once `tools/list` has cached the
 *     annotated schema and the tool is called with the exact arguments).
 *   - Most `auth/*` scenarios drive the OAuth authorization-code + PKCE flow.
 *     The fixture configures an `OAuth` provider whose redirect step is
 *     fulfilled by fetching the authorization URL: the conformance
 *     authorization server auto-approves and 302-redirects to the loopback
 *     callback with the code, which the OAuth callback server captures for
 *     `finishAuth()`. Pre-registration scenarios also hand the client a
 *     `client_id` / `client_secret` via the context.
 *   - `auth/client-credentials-*` scenarios use the OAuth 2.0 client-credentials
 *     grant instead. When the context carries a `client_secret`, the fixture
 *     discovers the token endpoint (RFC 9728 protected-resource metadata ->
 *     RFC 8414 authorization-server metadata) and drives fastmcp's
 *     `ClientCredentials` provider (which authenticates with client_secret_post).
 *     The `-basic` (client_secret_basic) and `-jwt` (private_key_jwt) variants
 *     demand token-endpoint auth methods fastmcp's `ClientCredentials` does not
 *     implement, so they remain expected failures in
 *     conformance-baseline-main.yml — product gaps, not fixture-wiring gaps.
 */
import { Client, OAuth, ClientCredentials } from '../../src/client/index.js'
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

// --- Optional per-scenario context (OAuth params, scripted tool calls) ---
type ScriptedToolCall = { name: string; arguments?: Record<string, unknown> }
type ScenarioContext = {
  name?: string
  client_id?: string
  client_secret?: string
  toolCalls?: ScriptedToolCall[]
}

/** Parses MCP_CONFORMANCE_CONTEXT defensively; returns {} when absent/invalid. */
function readContext(): ScenarioContext {
  const raw = process.env.MCP_CONFORMANCE_CONTEXT
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as ScenarioContext) : {}
  } catch {
    return {}
  }
}
const context = readContext()

// SEP-2243: the scenario's explicit tool-call script, when present.
const scriptedToolCalls = Array.isArray(context.toolCalls) ? context.toolCalls : undefined

// Fixed loopback port for the OAuth callback server. Must be non-zero and
// stable: it is baked into the registered redirect_uri (DCR) and re-sent in the
// authorization request, so the authorization server's redirect lands here.
// Scenarios run one at a time (run-client.mjs enumerates them), so a single
// fixed port never collides.
const OAUTH_CALLBACK_PORT = 39876

/**
 * Discovers the authorization server's token endpoint for a client-credentials
 * scenario, starting from the MCP server URL. Follows the standard MCP OAuth
 * discovery chain the interactive flow uses: RFC 9728 protected-resource
 * metadata (well-known path carries the resource path) -> its first
 * `authorization_servers` entry -> RFC 8414 authorization-server metadata ->
 * `token_endpoint`. `ClientCredentials` needs the concrete endpoint up front
 * (it does no discovery of its own).
 */
async function discoverTokenEndpoint(mcpUrl: string): Promise<string> {
  const server = new URL(mcpUrl)
  const prmUrl = new URL(`/.well-known/oauth-protected-resource${server.pathname}`, server.origin)
  const prm = (await fetch(prmUrl.toString()).then((r) => (r.ok ? r.json() : null))) as {
    authorization_servers?: string[]
  } | null
  const issuer = prm?.authorization_servers?.[0]
  if (!issuer) throw new Error(`no authorization_servers in ${prmUrl.toString()}`)
  const iss = new URL(issuer)
  const asMetaUrl = new URL(
    `/.well-known/oauth-authorization-server${iss.pathname === '/' ? '' : iss.pathname}`,
    iss.origin,
  )
  const asMeta = (await fetch(asMetaUrl.toString()).then((r) => (r.ok ? r.json() : null))) as {
    token_endpoint?: string
  } | null
  if (!asMeta?.token_endpoint) throw new Error(`no token_endpoint in ${asMetaUrl.toString()}`)
  return asMeta.token_endpoint
}

/**
 * Builds the auth provider for an `auth/*` scenario, or undefined otherwise.
 *
 * For `auth/client-credentials-*` scenarios whose context carries a
 * `client_secret`, drives fastmcp's `ClientCredentials` provider (OAuth 2.0
 * client-credentials grant, client_secret_post token-endpoint auth) against the
 * discovered token endpoint. The `-jwt` variant carries no `client_secret`
 * (it hands the client a `private_key_pem` for private_key_jwt, which fastmcp
 * does not implement), so it falls through to the OAuth path below and remains
 * an expected failure.
 *
 * Every other `auth/*` scenario uses the interactive OAuth provider.
 * `onRedirect` stands in for the user's browser: it GETs the authorization URL,
 * the conformance AS auto-approves and 302-redirects to the loopback callback
 * with `?code=...`, and the OAuth callback server resolves it for finishAuth().
 *
 * onRedirect AWAITS the fetch: the OAuth callback server resolves concurrently
 * on the same event loop (so there is no deadlock), and awaiting makes the
 * authorization request deterministically reach the AS before the flow
 * proceeds, rather than relying on an in-flight fire-and-forget GET.
 */
async function buildAuth(): Promise<OAuth | ClientCredentials | undefined> {
  if (!scenario.startsWith('auth/')) return undefined

  if (
    scenario.startsWith('auth/client-credentials-') &&
    typeof context.client_id === 'string' &&
    typeof context.client_secret === 'string'
  ) {
    const tokenEndpoint = await discoverTokenEndpoint(serverUrl)
    return new ClientCredentials({
      tokenEndpoint,
      clientId: context.client_id,
      clientSecret: context.client_secret,
    })
  }

  return new OAuth({
    callbackPort: OAUTH_CALLBACK_PORT,
    ...(typeof context.client_id === 'string' ? { clientId: context.client_id } : {}),
    ...(typeof context.client_secret === 'string' ? { clientSecret: context.client_secret } : {}),
    onRedirect: async (url: URL) => {
      await fetch(url.toString()).catch(() => {})
    },
  })
}

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
  const auth = await buildAuth()
  const client = new Client(serverUrl, {
    handlers: { sampling, elicitation },
    ...(versionNegotiation ? { versionNegotiation } : {}),
    ...(auth ? { auth } : {}),
  })

  // connect() performs the initialize handshake (the `initialize` scenario).
  // For auth/* scenarios it also runs the full OAuth dance (401 → discovery →
  // DCR/pre-registration → authorization-code + PKCE → token → reconnect).
  await client.connect()

  if (auth) {
    // auth/* scenarios: the handshake is what the checks assess. Exercising the
    // tool surface afterward is best-effort — some authorization-server MCP
    // endpoints expose no tools — so a tools failure must not fail the scenario.
    try {
      const tools = await client.listTools()
      for (const tool of tools) {
        try {
          await client.callToolRaw(tool.name, argsForTool(tool))
        } catch {
          /* tool-level failures are irrelevant to the auth checks */
        }
      }
    } catch (err) {
      process.stderr.write(`[everything-client] auth tool exercise skipped: ${String(err)}\n`)
    }
  } else if (scriptedToolCalls) {
    // SEP-2243: list first so the SDK caches the x-mcp-header-annotated schema,
    // then drive the exact scripted calls so it mirrors the parameters into
    // Mcp-Param-* headers with the encodings (base64-unsafe, omit-null) checked.
    await client.listTools()
    for (const call of scriptedToolCalls) {
      try {
        await client.callToolRaw(call.name, call.arguments ?? {})
      } catch (err) {
        process.stderr.write(`[everything-client] scripted tool '${call.name}' failed: ${String(err)}\n`)
      }
    }
  } else {
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
