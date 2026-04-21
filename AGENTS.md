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

**Context injection:** Ambient via `AsyncLocalStorage` — tool, resource, and prompt handlers call `mcp.getContext()` anywhere in the call tree during a request. Returns a fixed `McpContext` type (no generics):

```typescript
mcp.tool({ name: 'add', input: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => {
  const ctx = mcp.getContext()
  await ctx.info('adding numbers')
  return a + b
})
```

`mcp.getContext()` throws if called outside a live request handler.

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

**Input schema validation:** When `input` is provided, the client-supplied arguments are validated before the handler runs. A validation failure throws `McpError(InvalidParams)` — a protocol-level error signalling that the *client* sent bad arguments. The handler is never invoked.

**Output schema validation:** When `output` is provided, the handler's raw return value is validated against it before `convertResult` runs. Validation uses `~standard.validate()`, so it works across all Standard Schema libraries. Primitives, objects, and arrays are all valid output types — the output schema describes the handler's contract, not the MCP content shape. Validation failure returns `isError: true` (a tool execution error, not a protocol error, because the client's input was valid).

**Pagination:** `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list` all support cursor-based pagination per the MCP spec. Page sizes default to 50 and are configurable via `FastMCPOptions.toolsPageSize` / `FastMCPOptions.resourcesPageSize` / `FastMCPOptions.promptsPageSize`. Cursors are base64url-encoded identifiers (tool name, resource URI, or prompt name); a stale or invalid cursor throws `McpError(InvalidParams, 'Invalid or expired cursor')`. `InvalidParams` (not `MethodNotFound`) is used for unknown identifiers — the name/URI is a parameter, not a method.

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

**Prompts:** Registered with `mcp.prompt(config, handler)`. Config fields: `name` (inferred from `handler.name` when omitted), `title`, `description` (inferred via camelCase→words when omitted), `arguments` (array of `{ name, description?, required? }`), `disabled`, `timeout`, `auth`. Required arguments are validated before the handler runs — missing a required arg returns `InvalidParams` without invoking the handler. Handler receives a `Record<string, string>` of the supplied arguments and can return:

| Returned value | Conversion |
|---|---|
| `string` | Single user text message |
| `PromptMessage` | Wrapped in a one-element array |
| `PromptMessage[]` | Used as-is (multi-turn sequence) |
| `PromptResult(messages, description?)` | Passed through as-is (escape hatch) |

Content types for `PromptMessage.content`: `text`, `image`, `audio`, `resource` (embedded), `resource_link`.

**Tool `title`:** `ToolConfig` accepts an optional `title?: string` field (MCP 2025-03-26, from `BaseMetadataSchema`). Intended for UI display; takes precedence over `name` for human-readable labels. Passed through in `tools/list` responses. Transforms can read and rewrite `title` via `ToolView.title`.

**Context (`McpContext`):** The object returned by `mcp.getContext()` during a request. Fields and methods:

| Member | Description |
|---|---|
| `auth` | `AccessToken \| undefined` — verified bearer token for the request |
| `requestId` | `string \| undefined` — MCP request ID from the incoming message |
| `log(level, message, loggerName?)` | Send a log notification to the client (RFC 5424 levels) |
| `debug/info/notice/warning/error/critical/alert/emergency(msg, loggerName?)` | Convenience log shorthands |
| `reportProgress(progress, total?, message?)` | Send `notifications/progress` — no-op when no `progressToken` in the request |
| `sample(params)` | Ask the client to perform LLM inference (`sampling/createMessage`) — throws if client lacks `sampling` capability |
| `elicit(message, schema)` | Ask the client to collect user input via a form — throws if client lacks `elicitation` capability |
| `listRoots()` | Fetch declared filesystem roots from the client — throws if client lacks `roots` capability |
| `getState(key)` | Read a value from per-session state |
| `setState(key, value)` | Write a value to per-session state (survives across requests in the same session) |
| `deleteState(key)` | Remove a value from per-session state |

Session state is scoped to a single transport connection: HTTP sessions each get an isolated `Map<string, unknown>`; the stdio transport uses a single shared map for its lifetime.

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

**Middleware:** Registered with `mcp.use(mw)` (fluent) or via `FastMCPOptions.middleware`. The `Middleware` interface has three hook levels:

- `setup?(server)` — called once per `Server` instance; use to register notification handlers. `use()` calls `setup` immediately on `_primaryServer` so handlers are active before `connect()`/`run()`. HTTP sessions also call `setup` via `_makeServer()`.
- `onRequest?<T,R>(ctx, next)` — coarse hook that fires for every request that has no more-specific hook on that middleware instance.
- Per-method hooks: `onCallTool`, `onListTools`, `onReadResource`, `onListResources`, `onListResourceTemplates`, `onGetPrompt`, `onListPrompts` — take precedence over `onRequest` for their specific MCP method.

**Tool error vs infrastructure error:** The try/catch that converts errors to `{isError:true}` lives *outside* the middleware chain and only catches non-`McpError`. `McpError` from any middleware (rate limiting, etc.) propagates as a protocol error, not a tool result. `ErrorNormalizationMiddleware.onCallTool` explicitly re-throws `McpError` for the same reason.

**Built-in middleware:**

| Class | Purpose |
|---|---|
| `LoggingMiddleware` | Logs method, outcome, and elapsed time via a configurable emit function |
| `CachingMiddleware(ttl, keyFn?)` | TTL response cache; default key is `method:JSON(params)`; pass `CacheKeyFn` to partition by caller identity when using per-component auth |
| `RateLimitingMiddleware(limit, windowMs)` | Fixed-window token bucket; throws `McpError(InvalidRequest)` when exceeded |
| `SizeLimitingMiddleware(maxBytes)` | Throws `McpError(InternalError)` when serialised response exceeds limit |
| `ErrorNormalizationMiddleware` | `onCallTool` errors → `{isError:true}`; re-throws `McpError`; `onRequest` errors → `McpError(InternalError)` |
| `CancellationMiddleware` | Registers `CancelledNotification` handler in `setup()`; cancels in-flight requests via `AbortController` + `Promise.race` |

---

**Transforms:** View-only projections applied to list responses. Components hidden by a transform (method returned `null`) are removed from list results but remain callable by their original name/URI. Registered with `mcp.transform(t)` (fluent) or via `FastMCPOptions.transforms`. Applied in registration order.

**View types** (read-only snapshots passed into transform methods):

| Type | Fields |
|---|---|
| `ToolView` | `name`, `title?`, `description`, `tags` |
| `ResourceView` | `uri`, `name`, `tags`, `mimeType?`, `title?` |
| `PromptView` | `name`, `description`, `tags` |

**`SynthesizedTool`:** Produced by `Transform.synthesizeTools(resourceViews, promptViews)`. Fields: `name`, `title?`, `description`, `inputSchema?`, `auth?`, `timeout?`, `handler`. After synthesis, each synthesized tool is run through the `transformTool` chain (so `NamespaceTransform` renames `list_resources` → `v1_list_resources`, `FilterTransform` can hide it, etc.). The `synthesizeTools` callback receives already-filtered (disabled + auth-checked) and already-transformed views — it will not see restricted or disabled content.

**Routing with transforms active:**

- `CallTool`: synthesized tools checked by name first → scan registered tools through `transformTool` chain for a name match → direct registry lookup fallback (enables calling hidden tools by original name)
- `GetPrompt`: scan registered prompts through `transformPrompt` chain first → direct registry lookup fallback
- `ReadResource`: direct URI lookup → direct template match → scan statics through `transformResource` for a URI match → scan templates through `transformResourceTemplate` for a template match

**Built-in transforms:**

| Export | Purpose |
|---|---|
| `renameTool(original, new)` | Renames a single tool in list responses; original name still routes at call time |
| `redescribeTool(name, desc)` | Replaces a tool's description |
| `FilterTransform({ tools?, resources?, resourceTemplates?, prompts? })` | Hides components where predicate returns `false`; `resourceTemplates` falls back to `resources` predicate when omitted |
| `NamespaceTransform(prefix)` | Prefixes all `name` fields — tools, resources, prompts. **Does not alter URIs** (prefixing a URI scheme like `v1_data://` violates RFC 3986 §3.1); clients read resources by their original URI |
| `ResourcesAsTools()` | Synthesises a `list_resources` tool listing visible, transformed resource views |
| `PromptsAsTools()` | Synthesises a `list_prompts` tool listing visible, transformed prompt views |
| `VersionFilter(tag)` | Shows only components whose `tags` array contains the given string; components with no tags are always excluded |

---

**Composition:** Servers can be combined via mounting or proxying.

**`parent.mount(child, prefix?)`** — mirrors all tools, resources, and prompts from `child` into `parent`. The mirror is live: components registered on the child after `mount()` immediately appear in the parent. Mounting the same child twice is a no-op.

- **Prefix**: When a prefix is supplied, tool and prompt names are renamed `${prefix}_${name}`. Resource display names are prefixed the same way, but resource URIs are never altered (prefixing a URI scheme would violate RFC 3986 §3.1). Resources remain readable by their original URI.
- **Cascading**: Callbacks propagate through the parent's own `_toolRegisteredCallbacks`/`_resourceRegisteredCallbacks`/`_promptRegisteredCallbacks` arrays, so grandparent chains work naturally.
- **`list_changed` forwarding**: Adding a component to the child triggers `_notifyToolListChanged()` (or equivalent) on the parent, which sends the notification to all clients connected to the parent.
- **Close behaviour**: When the parent closes, it drains the child's `_proxyCloseCallbacks` — this closes any underlying proxy client connections.

**`createProxy(config: ProxyTransport, name?): Promise<FastMCP>`** — creates a plain `FastMCP` instance that forwards all calls to a remote MCP server. Initial sync fetches all tools, resources, resource templates, and prompts from the remote. Passthrough uses `ToolResult`, `ResourceResult`, and `PromptResult` to avoid double-conversion. The proxy registers a close callback so that `parent.mount(proxy)` then `parent.close()` also closes the proxy's underlying SDK `Client`.

```typescript
// Proxy types
type ProxyTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; requestInit?: RequestInit }
```

**Server capabilities:** FastMCP advertises `tools: { listChanged: true }`, `resources: { listChanged: true }`, `prompts: { listChanged: true }` — clients using the SDK's `listChanged` option receive notifications when component lists change. (Note: the SDK's `listChanged` constructor option has a known issue in-process; use `client.setNotificationHandler(ToolListChangedNotificationSchema, ...)` for reliable notification handling in tests.)

---

**Foundation:** Built on `@modelcontextprotocol/sdk` (official MCP TypeScript SDK).

**Module format:** ESM throughout (`"type": "module"`).

**Tests:** Vitest. Test files live in `tests/` (not colocated with source).
