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

**Resource subscriptions:** Not yet implemented. Python FastMCP also omits subscription support. The `subscribe` capability flag is not advertised.

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

**Composition:** Two mechanisms — mounting and proxying.

**Architecture choice:** Thin wrapper over the existing registration system. Mounting copies registrations directly into the parent's internal maps (`_tools`, `_staticResources`, `_templateResources`, `_prompts`) via mirroring helpers, rather than a separate routing layer. This means transforms, middleware, and auth all work identically on mounted components — no special-case code in the request handlers.

**`parent.mount(child, prefix?): this`** — mirrors all tools, resources, and prompts from `child` into `parent`. The mirror is live: components registered on the child after `mount()` appear in the parent immediately. Mounting the same child twice is a no-op (guarded by `_mountedChildren: Set<FastMCP>`).

- **Prefix**: tool and prompt names become `${prefix}_${originalName}`; resource display names are prefixed the same way; **resource URIs are never altered** — prefixing a scheme (`v1_data://`) violates RFC 3986 §3.1, and routing already works by original URI.
- **Live updates**: `tool()`, `resource()`, and `prompt()` each fire `_toolRegisteredCallbacks` / `_resourceRegisteredCallbacks` / `_promptRegisteredCallbacks` after the map write. `mount()` pushes callbacks onto the child's arrays. Adding to the child triggers the parent's mirror, which in turn writes into the parent's maps and fires `_notify*ListChanged()` — so connected clients see the change immediately.
- **Cascading**: the parent's mirror calls `this.tool(...)` / `this.resource(...)` / `this.prompt(...)`, which fire the parent's own callbacks. Grandparent chains propagate naturally.
- **Close**: `mount()` pushes a callback onto `parent._proxyCloseCallbacks` that drains `child._proxyCloseCallbacks`. When the parent closes, it drains its own proxy callbacks, which drain the child's — closing any underlying proxy SDK `Client` connections.

**`createProxy(config: ProxyTransport, name?): Promise<FastMCP>`** — returns a plain `FastMCP` instance whose handlers forward all calls to a remote MCP server. The returned value is just a `FastMCP` — `mount()` works on it identically to any in-process child.

Initial sync fetches tools, resources, resource templates, and prompts via `client.listTools()` etc. and registers forwarding handlers on the proxy instance. Passthrough uses `ToolResult(result)`, `ResourceResult(contents)`, and `PromptResult(messages, description)` so responses from the remote are returned verbatim without re-conversion.

The proxy registers `proxy._addCloseCallback(async () => client.close())` so that closing the parent (or calling `proxy.close()` directly) also closes the underlying SDK `Client` transport.

```typescript
type ProxyTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; requestInit?: RequestInit }
```

**`list_changed` capability:** FastMCP advertises `tools: { listChanged: true }`, `resources: { listChanged: true }`, `prompts: { listChanged: true }`. In tests, use `client.setNotificationHandler(ToolListChangedNotificationSchema, callback)` — the SDK `Client` constructor's `listChanged` option has a known in-process delivery issue and is unreliable in the same-process test environment.

---

## Client

**Design:** A flat `Client` class that implements three segregated interfaces — `IToolsClient`, `IResourcesClient`, `IPromptsClient` — plus the lifecycle members defined in `IClient`. Consumers can type parameters as a specific interface when they only need a subset of the API:

```typescript
async function callSomeTool(client: IToolsClient) { ... }
```

**Package entrypoint:** `fastmcp-ts/client`. All public types and the `Client` class are exported from `src/client/index.ts`.

**Lifecycle:** Ref-counted `connect()`/`close()` — multiple callers can share one connection. The ref count increments on each `connect()` call and decrements on each `close()`; the underlying SDK connection is only established on the first connect and only torn down when the count reaches zero. `isConnected()` returns whether the underlying SDK client is live. `[Symbol.asyncDispose]()` delegates to `close()` so `await using` works automatically.

```typescript
// Static factory — most common path
const client = await Client.connect(mcp)
await using _ = client  // closes on scope exit

// Manual ref-counted use
const client = new Client(mcp)
await client.connect()   // refCount → 1
await client.connect()   // refCount → 2
await client.close()     // refCount → 1, still open
await client.close()     // refCount → 0, SDK closed
```

**Transport resolution** (`resolveTransport`, internal — not re-exported): Accepts a `ClientTransportInput` union and returns `{ transport, beforeConnect? }`. The `beforeConnect` hook is required for in-process transports: the server must call `connect(serverSide)` before the SDK client connects to the client side.

| Input type | Resolved transport |
|---|---|
| `StdioTransport` instance | `StdioClientTransport` wrapping the subprocess |
| String URL | `StreamableHTTPClientTransport`; falls back to `SSEClientTransport` on 4xx |
| SDK `Transport` duck-type (has `.start`) | Passed through as-is |
| `McpConfig` (has `.mcpServers`) | First server entry resolved recursively |
| `McpServerLike` (has `.connect`) | `InMemoryTransport` pair; `beforeConnect` connects the server side |

`McpServerLike` is a structural interface — it matches `FastMCP` without importing from the server module, avoiding a circular dependency.

**Auth injection:** `BearerAuth` injects a static `Authorization: Bearer <token>` header into `requestInit.headers` (and `eventSourceInit.headers` for SSE). `OAuth` wraps the transport's `fetch` with an async function that resolves the current token and refreshes it when it is within `refreshBufferSeconds` of expiry. Concurrent refresh calls are coalesced to a single HTTP request.

**`ToolCallError`:** Thrown by `callTool()` when the server returns `isError: true`. Has a `content: ContentBlock[]` field containing the error blocks. `callToolRaw()` never throws — it returns the full result including `isError`.

**`toResult<T, E>()`:** Standalone utility (not on the `Client` object) that wraps a promise or async function into a `Result<T, E>` discriminated union `{ ok: true; value: T } | { ok: false; error: E }`, providing an error-as-value alternative to try/catch.

**Default options:** `ClientOptions.defaultOptions` accepts per-scope timeout defaults (`tool.timeout`, `resource.timeout`, `prompt.timeout`, and a global `timeout` fallback). All timeout values are in **seconds** in the public API; they are converted to milliseconds before being passed to the SDK. Per-request `RequestOptions.timeout` takes precedence over the scoped default.

**Handlers:**

| Option | Type | Behaviour |
|---|---|---|
| `handlers.log` | `LogHandler` | Called for every `notifications/message` from the server; receives `{ level, logger?, data }` |
| `handlers.progress` | `ProgressHandler` | Global default; overridden per-call via `CallToolOptions.onProgress` |
| `handlers.sampling` | `SamplingHandler` | Called when the server sends `sampling/createMessage`; client must also advertise `sampling` capability |
| `handlers.elicitation` | `ElicitationHandler` | Called when the server sends `elicitation/create`; client must advertise `elicitation` capability |

The SDK client capabilities are included only when the corresponding handler or option is provided:

| Handler / option | Advertised capability |
|---|---|
| `handlers.sampling` | `{ sampling: { tools: {} } }` — `tools: {}` is required so the server knows the client supports tool-call round-trips in sampling |
| `handlers.elicitation` | `{ elicitation: {} }` |
| `roots` | `{ roots: { listChanged: false } }` |

**Roots:** A `roots?: string[]` option on `ClientOptions` registers a `roots/list` request handler that returns the provided URIs. Dynamic roots (callback-based) are not yet implemented.

**`autoInitialize` option:** Stored in `ClientOptions` but currently has no effect — the underlying SDK's `connect()` always performs the MCP initialize handshake. Kept in the API for a future SDK path that supports deferred initialization.

---

**Sampling adapters:** Built-in `SamplingHandler` implementations for the three major providers. All adapters live in `src/client/sampling/` and are exported from `fastmcp-ts/client`.

**Core types:**

| Type | Description |
|---|---|
| `AnySamplingResult` | `CreateMessageResult \| CreateMessageResultWithTools` — a text-only or tool-use response |
| `SamplingAdapter` | Interface with one method: `asHandler(): SamplingHandler` |
| `ModelSelector` | `string \| ((prefs: ModelPreferences \| undefined) => string)` — static model name or a function |
| `OnTokenCallback` | `(token: string) => void` — fires for each text delta during streaming |
| `SamplingAdapterOptions` | `{ modelSelector?, onToken? }` — shared base options for all adapters |

**`GenericSamplingAdapter`** — wraps any async `GenericCompletionFn`. Handles model resolution and `maxTokens` defaulting (1024) but does no message format conversion — for provider-agnostic or custom integrations.

**`AnthropicSamplingAdapter`** — uses `client.messages.stream()` + `stream.on('text', cb)` + `stream.finalMessage()`. Key translations:
- `inputSchema` → `input_schema` (field rename required by Anthropic SDK)
- `toolChoice: 'required'` → `{ type: 'any' }`
- `end_turn` / `tool_use` / `max_tokens` / `stop_sequence` → `endTurn` / `toolUse` / `maxTokens` / `stopSequence`
- Default model: `claude-opus-4-5`

**`OpenAISamplingAdapter`** — uses `client.chat.completions.stream()` + `stream.on('content', cb)` + `stream.finalChatCompletion()`. Key translations:
- **Critical:** `maxTokens` → `max_completion_tokens` (NOT `max_tokens`) — the older field is silently ignored by recent OpenAI models
- `systemPrompt` injected as first message `{ role: 'system', content: ... }`
- Image content → `{ type: 'image_url', image_url: { url: 'data:<mimeType>;base64,<data>' } }`
- `tool_use` in messages → `tool_calls` array on the assistant message
- `finish_reason: 'tool_calls'` → `stopReason: 'toolUse'` with `ToolUseContent[]`
- Default model: `gpt-4o`

**`GoogleSamplingAdapter`** — uses `client.models.generateContentStream({ model, contents, config })`. Key translations:
- All Gemini-specific options go inside `config`: `maxOutputTokens`, `temperature`, `stopSequences`, `systemInstruction`, `tools`, `toolConfig`
- **`pruneTitle()`** strips all `title` fields from tool `inputSchema` recursively — Gemini rejects schemas with `title` fields with a `MALFORMED_FUNCTION_CALL` error
- MCP role `'assistant'` → Gemini role `'model'`
- `tool_result` messages require a name lookup via `buildToolNameMap()` (maps `toolUseId` → tool name from prior `tool_use` messages)
- `toolChoice: 'required'` → `{ functionCallingConfig: { mode: 'ANY' } }`; `'none'` → omits `tools` entirely
- `functionCalls` in response → `stopReason: 'toolUse'` with `ToolUseContent[]`
- `finishReason: 'MAX_TOKENS'` → `stopReason: 'maxTokens'`
- Default model: `gemini-2.0-flash`

Provider SDKs are optional peer dependencies (`@anthropic-ai/sdk >=0.39`, `openai >=4`, `@google/genai >=0.7`). Adapters import their SDK types with `import type` so no runtime error occurs if a peer is absent.

---

**Foundation:** Built on `@modelcontextprotocol/sdk` (official MCP TypeScript SDK).

**Module format:** ESM throughout (`"type": "module"`).

**Tests:** Vitest. Test files live in `tests/` (not colocated with source).
