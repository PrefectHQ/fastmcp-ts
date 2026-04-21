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
- [ ] Roots — static and dynamic filesystem context for servers
- [ ] Multi-server — connect to N servers from a single client with automatic namespacing

---

## Apps

- [ ] Tool-UI binding — associate tools with interactive UIs via `ui://` resources and serializable component trees
- [ ] Component library — layout, data display, charts, forms, conditional rendering, and client-side reactive state
- [ ] FastMCPApp — multi-tool apps with managed LLM visibility and composition-safe tool references
- [ ] Built-in providers — Approval, Choice, FileUpload, and FormInput
- [ ] Generative UI — LLM-designed interfaces rendered in a sandboxed runtime

---

## CLI

- [ ] `version` — display fastmcp-ts version, MCP SDK version, Node version, and platform
- [ ] `run` — start a FastMCP server from a file path (`server.ts`, `server.ts:app`) or URL; `--transport`, `--host`, `--port`, `--path` flags; `--reload` for file-watching auto-restart in development
- [ ] `inspect` — start a server from a file spec and report its tools, resources, and prompts; `--format` (text or JSON); `--output` to write a JSON report to disk
- [ ] `list` — connect to a running server and list its components; `--resources` and `--prompts` to include those types; `--input-schema`/`--output-schema` to print full schemas; `--json` for machine-readable output; `--auth` for bearer token or OAuth; `--command` to spawn a stdio server inline
- [ ] `call` — invoke a tool, read a resource, or get a prompt via `target key=value …` syntax; `--input-json` to supply arguments as a JSON string; `--json` for raw output; `--auth`; fuzzy name matching with suggestions on mismatch; `--command` for stdio servers
- [ ] `discover` — find locally configured MCP servers; sources: `claude-desktop`, `claude-code`, `cursor`, `gemini`, `goose`, `project` (`mcp.json` in cwd); `--source` to filter; `--json` for machine-readable output
- [ ] `install` — install a server into editor/client configs
  - [ ] `install claude-code` — write server entry to `~/.claude.json`
  - [ ] `install claude-desktop` — write server entry to `claude_desktop_config.json`
  - [ ] `install cursor` — write server entry to `.cursor/mcp.json`
  - [ ] `install gemini` — write server entry to `~/.gemini/settings.json`
  - [ ] `install goose` — write server entry to `~/.config/goose/config.yaml`
  - [ ] `install mcp-json` — write server entry to a local `mcp.json` file
- [ ] `dev` — development utilities
  - [ ] `dev inspector` — run a server and open the MCP Inspector UI; `--ui-port`, `--server-port`; file-watching auto-reload enabled by default

---

## Relationship to the ecosystem

| Package | Role |
|---|---|
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | Official low-level MCP protocol implementation — this library's foundation |
| [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) | Official MCP Apps extension SDK — foundation for the Apps pillar |
| [`fastmcp` (PyPI)](https://github.com/PrefectHQ/fastmcp) | The Python reference this project models its API after |
