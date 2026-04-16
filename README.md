# fastmcp-ts

A TypeScript/Node.js library for building and consuming [FastMCP](https://github.com/PrefectHQ/fastmcp) servers, clients, and apps. Built on top of the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

> **Status:** Pre-implementation. This checklist tracks what is planned and what has shipped.

---

## Servers

- [ ] Tools — declare callable functions with auto-generated schemas, type validation, structured output, and timeout support
- [ ] Resources — expose URI-addressed data as static files, dynamic functions, or parameterized templates
- [ ] Prompts — reusable parameterized message templates with multi-turn conversation support
- [ ] Context — dependency-injected runtime for logging, progress reporting, LLM sampling, user elicitation, and session state
- [ ] Transports — run over stdio, HTTP (Streamable), or SSE
- [ ] Authentication — JWT validation, OAuth 2.1 with Dynamic Client Registration, OAuth proxy, and composable multi-source auth
- [ ] Middleware — cross-cutting request/response interception with built-ins for logging, caching, rate limiting, and retries
- [ ] Transforms — rename, filter, reshape, or type-convert components as they flow to clients
- [ ] Composition — mount and proxy servers together with namespacing and live updates

---

## Clients

- [ ] Connection and lifecycle — transport auto-detection, connect/close, `AsyncDisposable`, and ping
- [ ] Transports — stdio (subprocess), HTTP, SSE, and in-process
- [ ] Tools — call and list tools with typed responses via Zod
- [ ] Resources — read static and templated resources with binary content support
- [ ] Prompts — list and render prompt templates
- [ ] Authentication — bearer tokens, OAuth 2.1 with PKCE and pluggable token persistence
- [ ] Handlers — log, progress, sampling, elicitation, and message notification callbacks
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

- [ ] `list` — inspect a server's tools, resources, and prompts
- [ ] `call` — invoke tools from the command line with automatic type coercion
- [ ] `discover` — find locally configured MCP servers (Claude Desktop, Claude Code, Cursor, etc.)

---

## Relationship to the ecosystem

| Package | Role |
|---|---|
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | Official low-level MCP protocol implementation — this library's foundation |
| [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) | Official MCP Apps extension SDK — foundation for the Apps pillar |
| [`fastmcp` (PyPI)](https://github.com/PrefectHQ/fastmcp) | The Python reference this project models its API after |
