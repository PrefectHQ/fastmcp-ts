# fastmcp-ts

A TypeScript/Node.js library for building and consuming [FastMCP](https://github.com/PrefectHQ/fastmcp) servers, clients, and apps. Built on top of the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

> **Status:** In active development. Checked items have shipped; unchecked items are planned.

---

## Servers

- [x] Tools — declare callable functions with Standard Schema input validation, structured output, return value conversion, and timeout support
- [x] Resources — expose URI-addressed data as static files, dynamic functions, or parameterized URI templates (RFC 6570); cursor-based pagination; `list_changed` notifications
- [x] Prompts — reusable parameterized message templates with multi-turn conversation support, argument validation, and pagination
- [x] Context — ambient runtime via `AsyncLocalStorage` for logging, progress reporting, LLM sampling, user elicitation, roots, and per-session state
- [x] Transports — stdio and HTTP (Streamable HTTP); env-var-driven transport selection (`MCP_TRANSPORT`, `MCP_HOST`, `MCP_PORT`, `MCP_PATH`); `address` getter for the bound HTTP port
- [x] Authentication — JWT validation, OAuth 2.1 with Dynamic Client Registration, OAuth proxy, and composable multi-source auth
- [x] Middleware — cross-cutting request/response interception with built-ins for logging, caching (with auth-aware key functions), rate limiting, size limiting, error normalisation, and cancellation
- [x] Transforms — rename, filter, or reshape components in list responses; synthesise new tools from resources and prompts; built-ins for filtering, namespacing, type conversion, and version gating
- [x] Composition — `mount(child, prefix?)` mirrors a child server's tools, resources, and prompts onto the parent with optional name-prefix namespacing; live: components added to a child after mounting appear in the parent immediately; `createProxy(config)` wraps a remote HTTP or subprocess MCP server as a mountable FastMCP instance; closing the parent tears down owned proxy connections

---

## Clients

- [x] Connection and lifecycle — transport auto-detection, ref-counted `connect()`/`close()`, `AsyncDisposable` (`await using`), `isConnected()`, `ping()`, and static `Client.connect()` factory
- [x] Transports — stdio (subprocess), Streamable HTTP, SSE, and in-process (direct `FastMCP` instance)
- [x] Tools — `listTools()`, `callTool()` (throws `ToolCallError` on server error), `callToolRaw()` (never throws); typed structured content via generics
- [x] Resources — `listResources()`, `listResourceTemplates()`, `readResource()`, `readResourceRaw()`; static and parameterised URI template resources
- [x] Prompts — `listPrompts()`, `getPrompt()` with argument passthrough
- [x] Authentication — `BearerAuth` (static token), `OAuth` (async lifecycle with pluggable token storage and auto-refresh)
- [x] Handlers — `log`, `progress` (per-request `onProgress` callback), `sampling`, and `elicitation` callbacks
- [x] Sampling adapters — built-in `AnthropicSamplingAdapter`, `OpenAISamplingAdapter`, and `GoogleSamplingAdapter`; optional provider SDKs as peer dependencies; streaming with `onToken` callback; protocol-level tool-call forwarding (`stopReason: 'toolUse'`); `GenericSamplingAdapter` template for custom providers
- [x] Roots — static (`string[]` / `Root[]`) or dynamic (async callback) filesystem roots advertised via `roots/list`; automatic `file://` URI normalisation; `notifyRootsChanged()` sends `notifications/roots/list_changed`
- [x] Multi-server — `MultiServerClient` connects to N servers from a single client; tools, resources, and prompts are namespaced by server name (`serverName_toolName`); `callTool()`, `getPrompt()`, and `readResource()` route automatically; `Client.connect()` returns a `MultiServerClient` transparently when given a multi-entry `McpConfig`
- [x] Resource subscriptions — `subscribeResource()` / `unsubscribeResource()` with a per-URI `ResourceUpdateHandler` callback; fires on `notifications/resources/updated`
- [x] Argument completion — `complete()` for server-side autocompletion of prompt and resource arguments (`completion/complete`)
- [x] Log level control — `setLogLevel()` to configure server-side log verbosity at runtime (`logging/setLevel`)
- [x] List-change notifications — `onToolsListChanged`, `onResourcesListChanged`, `onPromptsListChanged` handlers; configurable `autoRefresh` (default `true`) and `debounceMs` (default `300`); re-fetches and delivers updated lists on server-initiated `notifications/*/list_changed` events

---

## Apps

- [ ] `ui://` resources — standard MCP resources with `mimeType: text/html;profile=mcp-app`; served via `resources/list` and `resources/read`; `_meta.ui` carries CSP policy, browser permissions (`camera`, `microphone`, `geolocation`, `clipboardWrite`), a stable iframe `domain` origin, and `prefersBorder`; `io.modelcontextprotocol/ui` extension negotiated in `initialize` with graceful degradation to text-only tool responses when the host opts out
- [ ] Tool-UI binding — link any tool to a `ui://` resource via `_meta.ui.resourceUri`; `_meta.ui.visibility` controls who can call the tool: `"model"` (LLM-visible), `"app"` (hidden from LLM, invocable only from the rendered iframe), or both; resource URI auto-generated from tool name when not provided explicitly
- [ ] Host context — iframe receives `HostContext` on init: `theme` (`light`/`dark`), ~50 standardised CSS custom properties, `displayMode` (`inline`/`fullscreen`/`pip`), `containerDimensions`, `locale`, `timeZone`, `platform`, `deviceCapabilities`, and `safeAreaInsets`; View can request a display mode change and receive resize notifications
- [ ] Bidirectional communication — View↔Host JSON-RPC 2.0 over `postMessage`; View calls `tools/call`, `resources/read`, `sampling/createMessage`, `ui/message` (inject a user turn into the conversation), `ui/update-model-context`, `ui/open-link`, `ui/download-file`, and `ui/request-display-mode`; app-provided tools let the View register ephemeral tools callable by the host or agent for the iframe's lifetime
- [ ] Component library — layout (`Column`, `Row`, `Grid`), data display (`Table`, `Badge`, `Text`), charts (`Bar`, `Line`, `Area`, `Pie`), forms (`Input`, `Select`, `Button`), conditional rendering (`If`/`Elif`/`Else`), dynamic lists (`ForEach`), and client-side reactive state (`Rx`)
- [ ] FastMCPApp — model-visible entry-point tools that return component trees and are automatically linked to a `ui://` resource; UI-only backend tools hidden from the LLM but callable from within the rendered iframe; stable composition-safe tool references via hashed identifiers that survive namespace transforms; composable as a `Provider` via `server.mount()` and `server.addProvider()`
- [ ] Built-in providers — `Approval` (confirm/deny UI card with decision injected back into conversation), `Choice` (clickable option list), `FileUpload` (drag-and-drop file picker with server-side storage that bypasses the LLM context window), and `FormInput` (auto-generated validated form from a Zod schema with field-level error display)
- [ ] Generative UI — LLM generates component code at runtime via a registered `generate_ui` tool; component APIs discoverable via a companion `search_components` tool; code executes in an isolated sandbox; streamed to the host for progressive rendering via partial tool arguments; registers as a `Provider`
- [ ] `@fastmcp/ui-runtime` — client-side package for use inside app iframes; `useMCPApp()` hook delivers typed `toolInput`, `hostContext`, `callTool()`, `sendMessage()`, `updateModelContext()`, and `registerTool()`; `useTools<typeof server>()` generic derives fully-typed call signatures (tool names, argument shapes, return types) from the server's exported type — eliminates stringly-typed tool calls and gives full IntelliSense inside the iframe; framework-agnostic core with React bindings included
- [ ] Vite plugin (`@fastmcp/vite-plugin`) — co-locate server handler and React component in a single `.tool.tsx` file; plugin extracts the default-exported component, bundles it for the browser, auto-generates the `ui://` URI from the filename, registers the resource on the server, and wires `_meta.ui.resourceUri` — no URI strings written by hand; HMR for the UI component wired into `fastmcp dev --reload`

---

## CLI

- [x] `version` — display fastmcp-ts version, MCP SDK version, Node version, and platform
- [x] `run` — start a FastMCP server from a file path (`server.ts`) or URL; `--transport`, `--port` flags; `--reload` for file-watching auto-restart in development; `--host` and `--path` flags not yet implemented
- [x] `inspect` — start a server from a file spec and report its tools, resources, and prompts; `--json` for machine-readable output; `--output` to write a JSON report to disk not yet implemented
- [x] `list` — connect to a running server and list its components; `--resources` and `--prompts` to include those types; `--input-schema` to print full input schemas; `--json` for machine-readable output; `--auth` for bearer token; `--command` to spawn a stdio server inline; `--output-schema` not yet implemented
- [x] `call` — invoke a tool, read a resource, or get a prompt via `target key=value …` syntax; `--input-json` to supply arguments as a JSON string; `--json` for raw output; `--auth`; fuzzy name matching with suggestions on mismatch; `--command` for stdio servers
- [x] `discover` — find locally configured MCP servers; sources: `claude-desktop`, `claude-code`, `cursor`, `gemini`, `goose`, `mcp-json` (`mcp.json` in cwd); `--source` to filter; `--json` for machine-readable output
- [x] `install` — install a server into editor/client configs
  - [x] `install claude-code` — write server entry to `~/.claude.json`
  - [x] `install claude-desktop` — write server entry to `claude_desktop_config.json`
  - [x] `install cursor` — write server entry to `.cursor/mcp.json`
  - [x] `install gemini` — write server entry to `~/.gemini/settings.json`
  - [x] `install goose` — write server entry to `~/.config/goose/config.yaml`
  - [x] `install mcp-json` — write server entry to a local `mcp.json` file
- [x] `dev` — development utilities
  - [x] `dev inspector` — run a server and open the MCP Inspector UI; `--ui-port`, `--server-port`; file-watching auto-reload enabled by default

---

## Documentation

- [ ] Tooling — Mintlify (`docs/` folder in the main repo, served locally via `npx mint dev`); API reference auto-generated from TSDoc comments via TypeDoc and integrated into Mintlify as a dedicated **SDK Reference** tab; `llms.txt` / `llms-full.txt` endpoints for LLM-friendly sitemap and full-text access; MCP server endpoint at `/mcp` for AI-native docs queries
- [ ] Information architecture — mirroring `gofastmcp.com`: **Get Started** (installation, quickstart, concepts); **Servers** (tools, resources, prompts, context, auth, middleware, transforms, composition, deployment); **Clients** (transports, auth, sampling adapters, multi-server); **Apps** (overview, quickstart, `@fastmcp/ui-runtime`, Vite plugin, built-in providers, generative UI, low-level); **CLI**; **Integrations** (auth providers, AI assistants, AI SDKs); **SDK Reference** (auto-generated, separate tab)
- [ ] Apps guides — TypeScript-native DX that has no Python equivalent: **shared Zod schemas** (import the same schema in the server handler and the UI component — argument types and `toolInput` types flow through automatically with no duplication or codegen); **bring-your-own component library** (shadcn/ui, Radix, Mantine, Tailwind, etc.) with a guide to mapping `HostContext` CSS custom properties onto any design system's theme variables; `useTools<typeof server>()` reference; Vite plugin co-location walkthrough
- [ ] Servers, clients, and CLI guides — one guide per feature: tools, resources, prompts, context, middleware, auth, transforms, composition, transports, sampling adapters, roots, multi-server, each CLI command
- [ ] Integrations guides — auth providers; AI assistants (Claude Code, Claude Desktop, Cursor, Gemini CLI, Goose); AI SDKs (Anthropic, OpenAI, Google) with sampling adapter usage examples

---

## Relationship to the ecosystem

| Package | Role |
|---|---|
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | Official low-level MCP protocol implementation — this library's foundation |
| [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) | Official MCP Apps extension SDK — foundation for the Apps pillar |
| [`fastmcp` (PyPI)](https://github.com/PrefectHQ/fastmcp) | The Python reference this project models its API after |
