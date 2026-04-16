# fastmcp-ts

A TypeScript/Node.js client library for [FastMCP](https://github.com/PrefectHQ/fastmcp) and any MCP-compliant server. Brings the ergonomics of the FastMCP Python client to the Node ecosystem — transport auto-negotiation, clean async lifecycle, typed responses — built on top of the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

> **Status:** Pre-implementation. This checklist tracks what is planned and what has shipped.

---

## Feature Checklist

### Client

- [ ] `Client` class with single-argument instantiation
- [ ] `async`/`await` with explicit `connect()` / `close()` lifecycle
- [ ] `using` / `AsyncDisposable` support for automatic cleanup (TS 5.2+)
- [ ] `ping()` method
- [ ] `isConnected()` status check
- [ ] `initializeResult` property (server metadata and declared capabilities)
- [ ] `autoInitialize` option (default `true`; set `false` to call `initialize()` manually)

---

### Transports

Auto-detected from the argument passed to `Client`:

- [ ] **Stdio** — spawn a local process by command string or `{ command, args, env, cwd }` descriptor
  - [ ] `command` / `args`
  - [ ] `env` (explicit; does not inherit shell env by default)
  - [ ] `cwd`
  - [ ] `keepAlive` session persistence
- [ ] **Streamable HTTP** — connect by `https://` URL (recommended for production)
  - [ ] Custom `headers`
  - [ ] TLS/`rejectUnauthorized` option
- [ ] **SSE** — legacy Server-Sent Events transport for backward compatibility
  - [ ] Custom `headers`
- [ ] **In-process** — pass a `FastMCP` server instance (from `@modelcontextprotocol/sdk`) directly; zero-network, ideal for testing

---

### Tools

- [ ] `listTools()` — enumerate available tools with schemas
- [ ] `callTool(name, arguments)` — invoke a tool and return parsed content
- [ ] `callToolRaw(name, arguments)` — return the raw MCP `CallToolResult` object
- [ ] Typed tool responses via Zod schema (caller-supplied, validated against `structuredContent`)

---

### Resources

- [ ] `listResources()` — enumerate static resources
- [ ] `listResourceTemplates()` — enumerate parameterized URI templates
- [ ] `readResource(uri)` — read a resource by URI; returns text or binary content
- [ ] `readResource(uri, version)` — read a specific resource version
- [ ] `readResourceRaw(uri)` — return the raw MCP `ReadResourceResult` object
- [ ] Binary content (`blob`) support with MIME type passthrough

---

### Prompts

- [ ] `listPrompts()` — enumerate available prompt templates
- [ ] `getPrompt(name, arguments)` — render a prompt template; returns messages array

---

### Authentication

- [ ] **Bearer token** — pass a string to `auth`; `Bearer` prefix added automatically
- [ ] **`BearerAuth` class** — explicit token wrapper, compatible with custom schemes
- [ ] **Custom headers** — arbitrary `Authorization` or other headers on HTTP transports
- [ ] **OAuth 2.1 + PKCE**
  - [ ] Authorization Code flow with PKCE (RFC 7636)
  - [ ] Dynamic Client Registration (RFC 7591) as fallback
  - [ ] Automatic browser open for user consent
  - [ ] Token refresh on expiry
  - [ ] Scope configuration
  - [ ] Pluggable token persistence (filesystem, keychain, custom `AsyncKeyValue`)

---

### Callbacks & Handlers

- [ ] **`logHandler`** — receive structured log messages from the server
  - Eight severity levels: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`
  - `level`, `logger` (optional), `data` (`{ msg, extra }`) fields
  - Default: forward to Node `console` at appropriate level
- [ ] **`progressHandler`** — receive progress notifications for long-running tools
  - `progress`, `total`, `message` fields
- [ ] **`samplingHandler`** — respond to server-initiated LLM completion requests
  - Receives `messages`, `params` (system prompt, temperature, max tokens, tools), `context`
  - Built-in adapters: Anthropic SDK, OpenAI SDK
  - Custom handler support
- [ ] **`elicitationHandler`** — respond to server requests for structured user input
  - Receives `message`, `responseSchema` (JSON Schema), `params`, `context`
  - Returns `{ action: 'accept', content }` | `{ action: 'decline' }` | `{ action: 'cancel' }`
- [ ] **`messageHandler`** — unified handler for server notifications
  - Function-based (single callback inspects message type)
  - Class-based (`MessageHandler` with `onToolListChanged()`, `onResourceListChanged()`, `onPromptListChanged()` overrides)

---

### Roots

- [ ] Static roots — pass an array of local paths at construction time
- [ ] Dynamic roots — async callback invoked when the server requests roots; receives `RequestContext`

---

### Multi-Server

- [ ] `MCPConfig`-style multi-server client — connect to N servers from a single `Client` instance
- [ ] Automatic namespace prefixing for tool/resource names to avoid collisions
- [ ] Per-server auth and transport configuration

---

### CLI

A lightweight CLI for interacting with any MCP server during development:

- [ ] `fastmcp-ts list <server>` — print tool signatures, resources, and prompts
  - [ ] `--json` flag for machine-readable output
  - [ ] `--input-schema` / `--output-schema` flags to show full JSON schemas
- [ ] `fastmcp-ts call <server> <tool> [key=value...]` — invoke a tool
  - [ ] Automatic type coercion from CLI string values using tool schema
  - [ ] `--input-json` flag for complex/nested arguments
- [ ] `fastmcp-ts discover` — scan for locally configured MCP servers (Claude Desktop, Claude Code, Cursor, etc.)

---

## Relationship to the ecosystem

| Package | Role |
|---|---|
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | Official low-level MCP protocol implementation — this library's foundation |
| [`fastmcp` (PyPI)](https://github.com/PrefectHQ/fastmcp) | The Python reference this project models its client API after |

`fastmcp-ts` fills the gap: a FastMCP-quality **client** for TypeScript/Node.js.
