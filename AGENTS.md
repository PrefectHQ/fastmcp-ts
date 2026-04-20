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
| Plain object or array | JSON text content block + `structuredContent` |
| `Image(buffer, mimeType)` | Image content block |
| `File(buffer, name, mimeType)` | Binary blob content block |
| `ToolResult(...)` | Passed through as-is (escape hatch for full control) |

Binary types (`Buffer`, `Uint8Array`) always require an explicit wrapper — MIME type cannot be inferred. `ToolResult` is the escape hatch for returning multiple content blocks, suppressing `structuredContent`, or constructing raw MCP output.

**Dynamic registration:** Tools, resources, and prompts can be registered before or after `run()` is called. Adding a component to a running server automatically sends the appropriate `list_changed` notification to connected clients.

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
