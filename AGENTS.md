# fastmcp-ts — project context

TypeScript/Node.js implementation of [FastMCP](https://github.com/PrefectHQ/fastmcp). Covers all three pillars: servers, clients, and apps.

## Key decisions

**Runtime:** Node.js only. No browser support.

**Schema validation:** [Standard Schema](https://standardschema.dev/) (`@standard-schema/spec`) is the validation backbone. This is the shared interface implemented by Zod, Valibot, ArkType, and others — accepting it means callers are not locked to a specific library.

**Server API style:** Options object pattern. No decorators, no classes required. Config and handler are separate arguments — callbacks do not live inside config objects:

```typescript
mcp.tool({ name: 'add', input: z.object({ a: z.number(), b: z.number() }) }, ({ a, b }) => a + b)
```

This also gives TypeScript left-to-right generic inference: the schema type is resolved from the first argument before the handler type is checked.

**Context injection:** Ambient via `AsyncLocalStorage` — tool handlers call `mcp.getContext()` rather than receiving context as an argument. Context type `T` is inferred from a `context` factory function provided at server construction; no explicit generic annotation needed at call sites:

```typescript
const mcp = new FastMCP({
  name: 'my server',
  context: (request: McpRequest): MyCustomType => {
    return { ... }
  }
})

// Anywhere in the call tree during a request:
const ctx = mcp.getContext() // typed as McpContext<MyCustomType>
```

User data is nested under `ctx.data` to avoid collisions with built-in context fields (`log`, `reportProgress`, etc.).

**Tool return value conversion:** Magic conversion with an explicit escape hatch. The framework automatically converts return values to MCP content:

| Returned value | Conversion |
|---|---|
| `string` | Text content block |
| `number`, `boolean` | Stringified text content block |
| `undefined` / `void` | Empty result |
| Plain object | JSON text content block + `structuredContent` |
| Array | JSON text content block (no `structuredContent` — MCP spec requires it to be a plain object) |
| `Image(buffer, mimeType)` | Image content block |
| `File(buffer, name, mimeType)` | Binary blob content block |
| `ToolResult(...)` | Passed through as-is (escape hatch for full control) |

Binary types (`Buffer`, `Uint8Array`) always require an explicit wrapper — MIME type cannot be inferred. `ToolResult` is the escape hatch for returning multiple content blocks, suppressing `structuredContent`, or constructing raw MCP output.

**Tool name and description inference:** When `name` is omitted from `ToolConfig`, the handler function's `.name` property is used. When `description` is omitted, it is derived from the resolved name by converting camelCase to words (`getWeather` → `"get weather"`). Both are overridable by explicit values in config.

**Disabled tools:** A tool registered with `disabled: true` is completely inaccessible — it is hidden from `listTools` responses and rejected with `InvalidParams` on `tools/call`. Clients cannot distinguish a disabled tool from a non-existent one. This matches Python FastMCP's behavior.

**JSON Schema advertisement vs Standard Schema validation:** `ToolConfig` has two orthogonal layers for schemas:
- `input` / `output` — Standard Schema validators used for runtime validation. Works with any Standard Schema-compliant library (Zod, Valibot, ArkType, etc.) via `~standard.validate()`.
- `inputSchema` / `outputSchema` — explicit JSON Schema objects advertised to clients in `tools/list`. If omitted, FastMCP auto-generates from `input`/`output` via Zod v4's `z.toJSONSchema()`. A `console.warn` is emitted when auto-generation falls back to `{ type: 'object' }` (i.e., when the schema is not a Zod v4 schema).

**Output schema validation:** When `output` is provided, the handler's raw return value is validated against it before `convertResult` runs. Validation uses `~standard.validate()`, so it works across all Standard Schema libraries. Primitives, objects, and arrays are all valid output types — the output schema describes the handler's contract, not the MCP content shape. Validation failure returns `isError: true`.

**Pagination:** `tools/list` and `resources/list` / `resources/templates/list` support cursor-based pagination per the MCP spec. Page sizes default to 50 and are configurable via `FastMCPOptions.toolsPageSize` / `FastMCPOptions.resourcesPageSize`. Cursors are base64url-encoded identifiers (tool name or resource URI); a stale or invalid cursor falls back to the first page. `InvalidParams` (not `MethodNotFound`) is used for unknown identifiers — the name/URI is a parameter, not a method.

**Dynamic registration:** Tools, resources, and prompts can be registered before or after `run()` is called. Adding a component to a running server automatically sends the appropriate `list_changed` notification to connected clients.

**Resources:** Registered with `mcp.resource(config, handler)`. FastMCP auto-detects whether the URI is a static resource or a URI template by checking for `{` in the URI string — no separate method needed:

```typescript
// Static resource
mcp.resource({ uri: 'memo://readme', name: 'readme' }, () => 'Hello!')

// URI template — handler receives extracted params
mcp.resource({ uri: 'user://{id}' }, ({ id }) => `User ${id}`)
```

Static resources are served via `resources/list` + `resources/read`. Templates appear in `resources/templates/list` and are matched at read-time using RFC 6570 regex extraction. Three template parameter styles are supported: simple `{id}` (single path segment), wildcard `{path*}` (multi-segment), and query `{?q,lang}`.

**Resource return value conversion:** The `convertResourceResult()` function maps handler output to MCP `ReadResourceResult`:

| Returned value | Conversion |
|---|---|
| `string` | Text content (`mimeType` defaults to `text/plain`) |
| `Buffer` / `Uint8Array` | Base64 blob content (`mimeType` defaults to `application/octet-stream`) |
| Plain object / array | JSON-serialised text content (`mimeType` forced to `application/json`) |
| `null` / `undefined` | Empty text content |
| `ResourceResult(contents)` | Passed through as-is (escape hatch for full control) |

**Resource config fields:** `uri` (required), `name`, `title`, `description`, `mimeType`, `size` (bytes hint, static resources only), `annotations` (`audience`, `priority`, `lastModified`), `timeout` (ms), `disabled`, `tags`, `auth`. `title`, `size`, and `annotations` are forwarded verbatim in list responses. `size` is omitted from template list responses (unknown for parameterized URIs).

**Resource timeout:** Same `Promise.race` + `clearTimeout` pattern as tools. A timed-out handler throws an error that propagates as a JSON-RPC error to the client.

**Resource subscriptions:** Not implemented. Python FastMCP also omits subscription support. The `subscribe` capability flag is not advertised. The four subscription todos in the test file are deferred.

**Transport / `run()` API:** Single `mcp.run()` method with optional config object. Transport and HTTP options are resolved via the priority chain: **code > env vars > defaults**. This means a deployed server needs no code changes to switch transports — only env vars.

```typescript
mcp.run()                                         // fully env-driven
mcp.run({ transport: 'http' })                    // transport fixed; port/host from env
mcp.run({ transport: 'http', port: 3000 })        // fully explicit
```

Env vars: `MCP_TRANSPORT`, `MCP_HOST`, `MCP_PORT`, `MCP_PATH`. `PORT` (no prefix) is read as a fallback for `MCP_PORT` to support platforms (Railway, Render, Heroku) that set it automatically. Defaults: stdio transport, port 3000, host `0.0.0.0`, path `/mcp`.

Supported transports: `stdio`, `http` (Streamable HTTP). SSE is not supported — `SSEServerTransport` is deprecated in the MCP SDK; Streamable HTTP supersedes it.

For HTTP, the bound address (including the OS-assigned port when `port: 0` is used) is available via `mcp.address` after `run()` resolves. Returns `null` for stdio or before `run()` is called.

The `stdio` transport accepts optional `stdin`/`stdout` stream overrides in `RunOptions` (defaults to `process.stdin`/`process.stdout`). This allows stream injection in tests without spawning a child process.

**Package entrypoints:** Pillars are exposed as subpath entrypoints — `fastmcp-ts/server` and `fastmcp-ts/client` — so consumers only pull in what they use.

**Foundation:** Built on `@modelcontextprotocol/sdk` (official MCP TypeScript SDK).

**Module format:** ESM throughout (`"type": "module"`).

**Tests:** Vitest. Test files live in `tests/` (not colocated with source).
