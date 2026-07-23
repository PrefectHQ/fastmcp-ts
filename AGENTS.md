# fastmcp-ts — project context

TypeScript/Node.js implementation of [FastMCP](https://github.com/PrefectHQ/fastmcp). Covers all three pillars: servers, clients, and apps.

## Documentation

When writing, revising, reorganizing, or reviewing anything in `docs/` (concept guides, feature pages, API references, tutorials, or docstrings that compile into the docs), follow the conventions in the `writing-documentation` skill at `.claude/skills/writing-documentation/SKILL.md`. The docs site is Mintlify, configured in `docs/docs.json`.

## Key decisions

**Runtime:** Node.js only. No browser support.

**Protocol eras:** FastMCP is dual-era. One server instance serves both the 2025 legacy revision and the modern 2026-07-28 revision — a hybrid HTTP router forks the legacy sessionful transport from the modern stateless `createMcpHandler` path — and a client negotiates which era to use per connection. This split is the backdrop for the era-gated behavior described throughout this document: server→client requests (sampling/elicitation/roots), session state, `ping`/`setLogLevel`, and resource subscriptions each behave differently per era. The library `Client` default is `'legacy'` (see Client → version negotiation).

**SDK foundation:** Built on the v2 scoped MCP SDK packages (`@modelcontextprotocol/{client,core,node,server,server-legacy}` at `2.0.0-beta.5`), replacing the 1.x `@modelcontextprotocol/sdk`. `ProtocolError` / `ProtocolErrorCode` replace `McpError` / `ErrorCode`. The frozen `@modelcontextprotocol/server-legacy` carries the 2025-era transports and backs the built-in OAuth authorization server.

**Multi-round-trip (MRTR / input-required):** A handler returns `inputRequired(...)` (re-exported from `fastmcp-ts/server`, alongside `acceptedContent` / `inputResponse`) to ask the caller for more input mid-call. The caller re-invokes with `ctx.inputResponses` populated; flow state is carried across rounds via `ctx.requestState<T>()` / `ctx.mintRequestState<T>(payload)` (HMAC-signed when `FastMCPOptions.requestState` is set). Tuned through `FastMCPOptions.inputRequired`. This is the era-transparent replacement for push-style `ctx.sample()` / `ctx.elicit()`, which are deprecated and era-gated (see Context).

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

**Resource config fields:** `uri` (required), `name`, `title`, `description`, `mimeType`, `size` (bytes hint, static resources only), `annotations` (`audience`, `priority`, `lastModified`), `timeout` (ms), `disabled`, `tags`, `auth`, `complete`. `title`, `size`, and `annotations` are forwarded verbatim in list responses. `size` is omitted from template list responses (unknown for parameterized URIs). `complete?: Record<string, CompleteCallback>` maps a template parameter name to a completion callback (see Argument completion).

**Resource timeout:** Same `Promise.race` + `clearTimeout` pattern as tools. A timed-out handler throws an error that propagates as a JSON-RPC error to the client.

**Resource subscriptions:** `client.subscribeResource(uri, handler)` registers a `ResourceUpdateHandler = (uri: string) => void | Promise<void>` that fires when the server signals an update for that URI; `client.unsubscribeResource(uri)` removes it. Subscriptions are tracked in a `Map<uri, ResourceUpdateHandler>` on the client instance. The client is era-transparent: on a legacy connection it sends the `resources/subscribe` / `resources/unsubscribe` RPCs; on a modern connection it drives the `subscriptions/listen` bus via `_refreshResourceListenSubscription()` instead.

Server side: the legacy-era `resources/subscribe` / `resources/unsubscribe` handlers maintain a per-session subscription set (`__fastmcp_resource_subscriptions` in session state). Those RPCs are absent from the modern wire registry, so `_makeServer({ modern: true })` does not advertise `resources.subscribe`; modern connections use the `subscriptions/listen` bus. `mcp.notifyResourceUpdated(uri)` is the single public change signal across both eras — it pushes `notifications/resources/updated` to subscribed legacy sessions and publishes to the modern bus (which does its own per-stream filtering), so calling it for a URI with no subscribers is safe and cheap.

**Prompts:** Registered with `mcp.prompt(config, handler)`. Config fields: `name` (inferred from `handler.name` when omitted), `title`, `description` (inferred via camelCase→words when omitted), `arguments` (array of `{ name, description?, required?, complete? }`), `disabled`, `timeout`, `auth`. Each argument may carry a `complete?: CompleteCallback` for argument completion (see Argument completion). Required arguments are validated before the handler runs — missing a required arg returns `InvalidParams` without invoking the handler. Handler receives a `Record<string, string>` of the supplied arguments and can return:

| Returned value | Conversion |
|---|---|
| `string` | Single user text message |
| `PromptMessage` | Wrapped in a one-element array |
| `PromptMessage[]` | Used as-is (multi-turn sequence) |
| `PromptResult(messages, description?)` | Passed through as-is (escape hatch) |

Content types for `PromptMessage.content`: `text`, `image`, `audio`, `resource` (embedded), `resource_link`.

**Argument completion (server):** `completion/complete` is served from the `complete` callbacks on resource templates (`ResourceConfig.complete[param]`) and prompt arguments (`PromptArgument.complete`). A `CompleteCallback = (value, context?) => string[] | CompletionResult | Promise<...>` receives the partial value plus any resolved sibling arguments and returns suggestions; `normalizeCompletion` caps `values` at the 100-item wire limit and fills `total` / `hasMore`. The `completions` capability is advertised unconditionally in both eras (not era-forked), because `completion/complete` is in both era wire registries.

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

Session state is available on stdio (a single shared map for the transport's lifetime) and legacy HTTP sessions (each an isolated `Map<string, unknown>`). On a modern (2026-07-28) HTTP request there is no session store — every request runs statelessly — so `getState` / `setState` / `deleteState` each throw a pointed error (`SESSION_STATE_MODERN_HTTP_ERROR`) rather than silently reading or writing a fresh per-request map. Use `ctx.requestState()` for per-request state and `ctx.mintRequestState()` to carry state across a multi-round-trip flow (see MRTR).

**Transport / `run()` API:** Single `mcp.run()` method with optional config object. Transport and HTTP options are resolved via the priority chain: **code > env vars > defaults**. This means a deployed server needs no code changes to switch transports — only env vars.

```typescript
mcp.run()                                         // fully env-driven
mcp.run({ transport: 'http' })                    // transport fixed; port/host from env
mcp.run({ transport: 'http', port: 3000 })        // fully explicit
```

Env vars: `MCP_TRANSPORT`, `MCP_HOST`, `MCP_PORT`, `MCP_PATH`. `PORT` (no prefix) is read as a fallback for `MCP_PORT` to support platforms (Railway, Render, Heroku) that set it automatically. Defaults: stdio transport, port 3000, host `0.0.0.0`, path `/mcp`.

Supported transports: `stdio`, `http` (Streamable HTTP). SSE is not supported — `SSEServerTransport` is deprecated in the MCP SDK; Streamable HTTP supersedes it.

**DNS-rebinding protection:** `FastMCPOptions.dnsRebinding` guards the HTTP transport by validating `Host` / `Origin` headers (hostname-only, port-agnostic; mismatch → `403`). Default posture (option omitted): protection auto-enables only when `run()` binds to a loopback host (`127.0.0.1`, `::1`, `localhost`) — the deployment the attack targets. A bind to a routable interface (including the default `0.0.0.0`) is left open, and the first such serve with no `dnsRebinding` config logs a one-time warning (`_dnsRebindingWarned`, deduped per process; any explicit `dnsRebinding` — even `enabled: false` — suppresses it). Routable deployments opt in with `allowedHosts` / `allowedOrigins`. stdio is unaffected.

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
| `CachingMiddleware(ttl, keyFn?)` | TTL response cache; default key `method:authPartition:JSON(params)` partitions by identity (`anon` when unauthenticated, else SHA-256 of the bearer token — hash never raw); a custom `CacheKeyFn` **replaces** that partitioning (its owner then owns identity). Never caches `resources/subscribe`/`unsubscribe` (mutate session state) or `input_required` rounds (single-use flow token) |
| `RateLimitingMiddleware(limit, windowMs)` | Fixed-window token bucket; throws `ProtocolError(ProtocolErrorCode.InvalidRequest)` when exceeded |
| `SizeLimitingMiddleware(maxBytes)` | Throws `ProtocolError(ProtocolErrorCode.InternalError)` when serialised response exceeds limit |
| `ErrorNormalizationMiddleware` | `onCallTool` errors → `{isError:true}`; re-throws `ProtocolError`; `onRequest` errors → `ProtocolError(ProtocolErrorCode.InternalError)` |
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

## Apps

**Extension key:** `io.modelcontextprotocol/ui`, advertised under `serverCapabilities.extensions` with value `{ mimeTypes: ['text/html;profile=mcp-app'] }` (`UI_RESOURCE_MIME_TYPE`). A legacy client reads it from the `initialize` handshake; a modern (2026-07-28) client reads it from the `server/discover` document — the same advertisement, a different discovery surface. Only added when `_hasUiComponents()` returns true. `_primaryServer` is rebuilt at the start of `connect()` so registrations made after the constructor (the common case) are captured.

**`_hasUiComponents()`:** Returns true if any registered tool has a `ui` field, or if any registered resource URI starts with `ui://`. Called inside `connect()` to decide whether to include the extension in `ServerInfo`.

**`isUiCapable(clientCapabilities)`:** The per-request check for whether a client can render UI. Per SEP-1865 the client must declare `mimeTypes` (REQUIRED) as the *value* of its own `io.modelcontextprotocol/ui` capability entry; `isUiCapable` returns true only when that array includes `text/html;profile=mcp-app` — a bare presence of the extension key is insufficient. Gates both `tools/list` `_meta.ui` inclusion and the `tools/call` graceful-degradation path.

**`ToolConfig.ui`:** Optional `UiToolMeta` field on tool config:

```typescript
interface UiToolMeta {
  visibility?: Visibility[]   // ['model'] | ['app'] | ['model','app']
  resourceUri?: string        // defaults to `ui://${name}` when omitted
}
```

`listTools` filters out tools where `visibility` does not include `'model'`. For UI-capable clients, each tool response includes `_meta.ui` with `resourceUri` and `visibility`. Tools without a `ui` field are always included in `listTools` normally.

**Graceful degradation:** When `callTool` is called on a tool with a `ui` config by a client that is not `isUiCapable` (has not declared the `text/html;profile=mcp-app` mimeType), and the handler returns a `structuredContent` response, the MCP layer strips `structuredContent` and returns `'[UI not available in this client]'` as a plain text content block.

**`ResourceConfig.ui`:** Optional `ResourceUiMeta` field:

```typescript
interface ResourceUiMeta {
  csp?: CspPolicy
  permissions?: BrowserPermissions
  domain?: string
  prefersBorder?: boolean
}
interface CspPolicy {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}
interface BrowserPermissions {
  camera?: Record<string, never>
  microphone?: Record<string, never>
  geolocation?: Record<string, never>
  clipboardWrite?: Record<string, never>
}
```

These are forwarded as `_meta.ui` in `resources/list` and `resources/read` responses for UI-capable clients. `CspPolicy` uses per-directive domain arrays rather than a flat string (spec-aligned). `BrowserPermissions` is a keyed object (presence of a key grants that permission) rather than a string array.

**`McpContext.resolveToolName(name)`:** Added to the `McpContext` interface. Default implementation in `createContext()` is `(name) => name` (identity). `_mirrorTool` in `FastMCP` overrides it in the child's `McpContext` to `(name) => \`${prefix}_${name}\`` so that handlers inside a mounted child resolve the prefixed name when generating action strings.

**`actionRef(name)`:** Standalone helper exported from `src/server/apps/actionRef.ts`. Reads `contextStore.getStore()?.resolveToolName(name) ?? name`. Called at handler execution time (not at registration time), so the correct prefix is resolved from `AsyncLocalStorage` context. Used by provider Button components to generate mount-prefix–aware action strings.

**`FastMCPApp`:** Thin wrapper around `FastMCP`. Provides:
- `entrypoint(config, handler)` — registers a tool with `visibility: ['model', 'app']` and automatically registers a stub `text/html;profile=mcp-app` resource at `ui://${name}` so `resources/read` doesn't 404 before the real UI bundle is wired in.
- `backendTool(config, handler)` — registers a tool with `visibility: ['app']` by default; pass `visibility: ['model', 'app']` to expose it to the LLM as well.
- `toolRef(name)` — calls `contextStore.getStore()?.resolveToolName(name) ?? name`; same as `actionRef` but instance-scoped.
- `server` — the underlying `FastMCP` instance; pass to `parent.addProvider(app)` or `parent.mount(app.server)`.

**`addProvider(provider)`:** Added to `FastMCP`. Accepts `FastMCPApp | FastMCP` and calls `this.mount()` on the underlying server. Convenience method so callers don't need to unwrap `.server`.

**Built-in providers** (all in `src/server/apps/providers/`):

| Provider | Tools registered | Notes |
|---|---|---|
| `Approval` | `${name}`, `${name}_confirm`, `${name}_deny` | Confirm/deny are `visibility: ['app']`; uses `actionRef` for button actions |
| `Choice` | `${name}`, `${name}_select` | Each option button carries `args: { option }` on the Button node; `_select` is `visibility: ['app']` |
| `FileUpload` | `file_upload_open`, `file_upload_submit`, `file_upload_delete` (+ `ui://files/{handle}` resource) | `submit` stores bytes via `FileStorageAdapter` and returns a server-minted `FileHandle` id; cleanup is TTL-based (default in-memory adapter, `FileUploadOptions.ttlMs`, 30 min) with best-effort `ctx.onClose` release on sessionful transports only — no session-state handle list |
| `FormInput` | `${name}`, `${name}_submit` | Uses shared `toJsonSchema` from `tool.ts` (supports Zod v4, Valibot, ArkType); renders fields from JSON Schema `properties`; `_submit` validates via `schema['~standard'].validate` |

**`GenerativeUI`:** Creates an internal `FastMCP` with `name: 'generative-ui'` and registers two tools:
- `search_components` — returns `COMPONENT_CATALOG` as JSON text in `content[0].text` (not `structuredContent` — the MCP SDK rejects arrays there); no `ui` config.
- `generate_ui` — runs caller-supplied JS expression in `vm.runInNewContext(code, sandbox, { timeout: 2000 })`; sandbox contains only the component builder functions (no Node globals); no `ui` config.

**Component model:** Pure JSON-serializable trees. All builders return plain objects `{ type, props?, children? }`. `If` is the only exception: `.elif()` and `.else()` chaining methods are attached via `Object.defineProperty` with `enumerable: false` so Vitest's `toEqual` ignores them and only compares the data fields (`type`, `branches`, `fallback?`).

```typescript
// If/elif/else chaining
If({ condition: 'x > 0' }, Text('positive'))
  .elif({ condition: 'x < 0' }, Text('negative'))
  .else(Text('zero'))
// → { type: 'if', branches: [...], fallback: { type: 'text', ... } }
```

**`toJsonSchema` in `FormInput`:** Rather than hand-rolling Zod v4 extraction (which diverged: `_def.type` not `_def.typeName`, shape as plain object not function), `FormInput` uses the shared `toJsonSchema(schema, label)` helper from `tool.ts`. This handles Zod v4, Valibot, ArkType, and anything else Standard Schema supports via the same code path as tool input schema advertisement.

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

**Version negotiation:** `ClientOptions.versionNegotiation` selects the protocol era at connect(). Default is `'legacy'` (field omitted) — the plain 2025 sequence, byte-identical to prior behavior, no `server/discover` probe. `{ mode: 'auto' }` probes with `server/discover` and uses modern when the server supports it (else falls back to legacy); `{ mode: { pin: '2026-07-28' } }` requires modern outright. `getProtocolEra()` reads the negotiated era after connect (`undefined` before). The library default stays `'legacy'` — the auto-for-HTTP / legacy-for-stdio split lives in the CLI layer (`src/cli/utils/connect.ts`), not in `Client`. A cached era verdict from a prior connection to the same server can skip the probe entirely.

**Era-aware operations:** Several members fork on the negotiated era. `subscribeResource` / `unsubscribeResource` use the legacy RPCs on legacy and the `subscriptions/listen` bus on modern (see Resource subscriptions). `ping()` sends the `ping` RPC on legacy; on modern — where `ping` is not a wire method — it uses the SDK-native `discover()`. `setLogLevel()` sends `logging/setLevel` on legacy; on modern (deprecated, absent from the registry) it records the level and threads it into `_meta['io.modelcontextprotocol/logLevel']` on every subsequent request via `_metaParams()`.

**Transport resolution** (`resolveTransport`, internal — not re-exported): Accepts a `ClientTransportInput` union and returns `{ transport, beforeConnect? }`. The `beforeConnect` hook is required for in-process transports: the server must call `connect(serverSide)` before the SDK client connects to the client side.

| Input type | Resolved transport |
|---|---|
| `StdioTransport` instance | `StdioClientTransport` wrapping the subprocess |
| String URL | `StreamableHTTPClientTransport`. SSE is explicit opt-in via `ClientOptions.legacySSE` (default `false`); an `/sse` URL throws pointing at Streamable HTTP and the flag, and only connects `SSEClientTransport` when `legacySSE: true` |
| SDK `Transport` duck-type (has `.start`) | Passed through as-is |
| `McpConfig` (has `.mcpServers`) | First entry resolved via `resolveEntryTransport()`; single-entry configs go through the same helper as multi-server |
| `McpServerLike` (has `.connect`) | `InMemoryTransport` pair; `beforeConnect` connects the server side |

`McpServerLike` is a structural interface — it matches `FastMCP` without importing from the server module, avoiding a circular dependency.

`McpServerValue = McpServerEntry | McpServerLike` — the values in `mcpServers` accept either a config object (`{ url }` or `{ command }`) or a live in-process server instance. `resolveEntryTransport(entry, auth?)` is the shared helper used by both `resolveTransport` (single-server McpConfig path) and `MultiServerClient` (per-server connections).

**Auth injection:** `BearerAuth` injects a static `Authorization: Bearer <token>` header into `requestInit.headers` (and `eventSourceInit.headers` for SSE). `OAuth` wraps the transport's `fetch` with an async function that resolves the current token and refreshes it when it is within `refreshBufferSeconds` of expiry. Concurrent refresh calls are coalesced to a single HTTP request.

`OAuth` also supports Client ID Metadata Documents (CIMD, SEP-991) via `OAuthOptions.clientMetadataUrl` — an HTTPS URL the client presents as its identity in place of Dynamic Client Registration, validated eagerly so a malformed URL fails fast. The authorization-code callback validates the RFC 9207 `iss` parameter and keys credentials per issuer (SEP-2352, a "last issuer seen for this server" pointer); pass the callback `URLSearchParams` (including `code` and any `iss`) to `finishAuth()`. `ClientCredentials` fetches a token with `grant_type=client_credentials`, sending `client_id` + `client_secret` in the POST body — `client_secret_post` only; `client_secret_basic` and `private_key_jwt` are not implemented.

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
| `handlers.onToolsListChanged` | `ListChangedHandler<Tool>` | Called when the server sends `notifications/tools/list_changed`; `autoRefresh: true` (default) re-fetches the list before invoking `onChanged`; `debounceMs: 300` (default, set to `0` in tests for instant delivery) |
| `handlers.onResourcesListChanged` | `ListChangedHandler<Resource>` | Same pattern for `notifications/resources/list_changed` |
| `handlers.onPromptsListChanged` | `ListChangedHandler<Prompt>` | Same pattern for `notifications/prompts/list_changed` |

The SDK client capabilities are included only when the corresponding handler or option is provided:

| Handler / option | Advertised capability |
|---|---|
| `handlers.sampling` | `{ sampling: { tools: {} } }` — `tools: {}` is required so the server knows the client supports tool-call round-trips in sampling |
| `handlers.elicitation` | `{ elicitation: {} }` |
| `roots` | `{ roots: { listChanged: false } }` |

**Roots:** `ClientOptions.roots` accepts `string[]` (plain URIs), `Root[]` (objects with `uri` and optional `name`), or an async callback `() => string[] | Root[] | Promise<...>` for dynamic roots. URIs without a `file://` scheme are normalised automatically. `client.notifyRootsChanged()` sends `notifications/roots/list_changed` to the server. The advertised capability includes `listChanged: true` only when a callback is provided (static roots never change).

**`autoInitialize` option:** Stored in `ClientOptions` but currently has no effect — the underlying SDK's `connect()` always performs the MCP initialize handshake. Kept in the API for a future SDK path that supports deferred initialization.

**Argument completion:** `client.complete(ref, argument, context?, options?)` sends `completion/complete` and returns a `CompletionResult`. `ref` is either `{ type: 'ref/prompt'; name: string }` or `{ type: 'ref/resource'; uri: string }`. `argument` is `{ name: string; value: string }`. Optional `context.arguments` passes previously resolved argument values for multi-argument completion.

**Log level control:** `client.setLogLevel(level, options?)` sets the log level; `level` is one of the RFC 5424 severity strings (`'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'`). On a legacy connection it sends `logging/setLevel` and the server filters forwarded notifications by it; on a modern connection the RPC is deprecated, so the level rides in per-request `_meta` instead (see Era-aware operations).

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

## MultiServerClient

**Design:** Implements `IClient` by holding a `Map<serverName, SdkClient>` — one underlying SDK client per named server in the `McpConfig`. Parallel connect and parallel close. All list operations aggregate across every server; all routed operations dispatch to exactly one server.

**DX entry point:** `Client.connect(config)` is overloaded — when given a `McpConfig` with more than one entry it returns a `MultiServerClient` directly. Single-entry configs continue to return a `Client`. Users import only `Client` for either case:

```typescript
const multi = await Client.connect({
  mcpServers: {
    github: { url: 'https://github-mcp.example.com' },
    jira:   { command: 'npx', args: ['jira-mcp'] },
  },
})
// TypeScript infers: MultiServerClient
const tools = await multi.listTools()  // ['github_list_repos', 'jira_create_issue', ...]
await multi.callTool('github_list_repos', { org: 'PrefectHQ' })
```

**Namespacing rules:**
- Tools: `${serverName}_${toolName}` — e.g. `github_search`
- Prompts: `${serverName}_${promptName}`
- Resources: display `name` prefixed the same way; **URIs are never altered** (same reasoning as `NamespaceTransform` — prefixing a scheme violates RFC 3986 §3.1)

**Resource routing:** `listResources()` and `listResourceTemplates()` populate an internal `Map<uri, serverName>`. `readResource(uri)` looks up that map for an O(1) dispatch. If the map is empty (i.e. `listResources()` was never called), it falls back to trying each server in order and returning the first success. Throws with a clear message if the URI is not found on any server.

**Tool/prompt routing:** `callTool(namespacedName, ...)` and `getPrompt(namespacedName, ...)` split on the first `_` to extract `serverName` and `localName`, then dispatch to the matching `SdkClient`. Throws with the list of known servers if the prefix is unrecognised.

**Per-server auth:** `McpServerEntry` accepts an `auth?` field (`BearerAuth | OAuth | ClientCredentials | string`). `resolveEntryTransport` resolves per-entry auth first, falling back to any auth passed at the `MultiServerClient` level. `BearerAuth` and `ClientCredentials` work per server; there is no interactive-OAuth (authorization-code) flow at the multi-server level.

**Version negotiation:** `MultiServerOptions.versionNegotiation` requests the same mode of every sub-client (same shape as `ClientOptions.versionNegotiation` on the single-server `Client`), applied per connection. `getProtocolEra(serverName)` reads the negotiated era for one named sub-client. Era-aware operations (`ping`, `setLogLevel`, resource subscriptions) resolve per sub-client from its own negotiated era.

**Shared handlers:** `handlers.log`, `handlers.sampling`, and `handlers.elicitation` are registered on every sub-client so messages from any server reach the same handler. The sampling capability is advertised to all servers when the handler is provided.

**Connect failure semantics:** If any server fails `connect()`, all connections that succeeded are closed and the error is re-thrown. No partial-connected state is observable.

**`resolveEntryTransport(entry, auth?)`:** Exported from `transports.ts`. Handles all three entry types — `McpServerLike` (in-process via `InMemoryTransport` pair), `{ url }` (HTTP/SSE), and `{ command }` (stdio subprocess). Both `resolveTransport` (single-server McpConfig path) and `MultiServerClient._doConnect()` call it.

---

## CLI

**Bundle:** The CLI is built as a self-contained CJS bundle (`dist/cli/index.cjs`) via tsup with `noExternal: /.*/`. This means all dependencies — including the v2 MCP SDK packages — are inlined, so users don't need to install anything beyond the package itself. The shebang (`#!/usr/bin/env node`) and compile-time constants `__FASTMCP_VERSION__` / `__MCP_SDK_VERSION__` are injected by tsup at build time; `__MCP_SDK_VERSION__` is read from `@modelcontextprotocol/server` (the v2 packages share one version). The v2 packages ship well-formed `exports` maps, so esbuild resolves their subpaths natively — the old custom `.js`-appending esbuild plugin (needed for the 1.x `@modelcontextprotocol/sdk` subpath imports) is gone.

**Framework:** `citty` for command parsing. Commands are lazy-loaded via dynamic `import()` in `subCommands`, keeping startup time minimal. Global `--quiet` and `--json` flags are set once in the root `setup()` hook and stored in module-level state (`output.ts` / `format.ts`).

**stdout / stderr discipline:** Human-readable output (tables, spinners, section headers, key-value pairs, status messages) goes to **stderr** via `log.*`. Machine-readable output (raw tool results, resource content, JSON mode) goes to **stdout** via `log.raw()` or `output()`. This keeps the CLI composable in pipelines — `fastmcp call ... | jq` works correctly.

**UI modules (`src/cli/ui/`):**
- `theme.ts` — chalk-based palette: primary (bold cyan), success (green), warning (yellow), error (red), muted (dim gray), value (white), label (bold), url (cyan underline), code (dim white)
- `symbols.ts` — Unicode/ASCII fallback symbols based on `TERM !== 'dumb' && !CI`
- `output.ts` — `log` object; all methods write to stderr except `log.raw` (stdout); respects `quiet` flag
- `format.ts` — `output<T>(data, renderFn)` dispatcher: JSON.stringify to stdout in JSON mode, renderFn otherwise
- `spinner.ts` — `withSpinner(label, fn)` wraps async ops with `@clack/prompts` spinner; no-op when quiet
- `table.ts` — `renderTable(headers, rows)` via `cli-table3`; writes to stderr
- `schema.ts` — `renderSchema(jsonSchema, json)` pretty-prints JSON Schema properties with type, required/optional, and description

**Utils (`src/cli/utils/`):**
- `connect.ts` — `connectClient(mode, auth?)`: three modes: `url` (HTTP), `stdio` (subprocess), `inprocess` (spawns file via `npx tsx` or `node` with `MCP_TRANSPORT=stdio`)
- `file-spec.ts` — `parseFileSpec("server.ts:app")`: splits on last colon (skips Windows drive letters via `colonIdx > 1`), resolves absolute path, checks existence, detects TypeScript by extension; **note: `exportName` is parsed but not yet used by any command**
- `config-paths.ts` — `getConfigPaths()`: platform-aware paths for all six install targets; `readConfig`/`writeConfig` branch on `json` vs `yaml` format; Goose config uses YAML
- `auth.ts` — `resolveAuth(flag)`: parses `--auth` string into `BearerAuth`; OAuth not available in CLI
- `error.ts` — `cliError(message, opts)`: writes to stderr and exits; `formatError(err)`: normalises ECONNREFUSED/401/404 to friendly messages; exit codes: OK=0, USER=1, CONNECTION=2, SERVER=3
- `fuzzy.ts` — `closestMatch(query, candidates)` using `fastest-levenshtein`; threshold 4; used by `call` for name suggestions

**Command notes:**

**Era flags:** the connecting commands (`list`, `call`, `inspect`) accept `--modern` and `--pin <revision>` era selectors, resolved per transport by `resolveVersionNegotiation` (`src/cli/utils/connect.ts`): a URL transport defaults to `mode: 'auto'` (auto-for-HTTP), stdio / in-process default to legacy and `--modern` opts them into `auto`, and `--pin` forces a pinned modern era (winning over `--modern`). This CLI-layer default is what applies auto-for-HTTP; the library `Client` default stays `'legacy'`.

`run` — Spawns file via `npx tsx` (TypeScript) or `node` (JS) with `MCP_TRANSPORT` / `MCP_PORT` env vars. Detects server start from "listening/started/running" keywords in stderr; for HTTP servers this fires reliably. `--reload` uses `chokidar` to kill and respawn on file change. The `exportName` from `server.ts:app` file spec syntax is parsed but not passed to the subprocess — only the file path is used.

`inspect` — Spawns the server file via `inprocess` mode (`StdioTransport` to `npx tsx`), lists tools/resources/prompts in parallel, renders tables. Does not paginate beyond the first page.

`list` — Connects via URL or `--command`. The `--command` value is passed as a single string to `StdioTransport(command, [])` — **multi-word commands like `npx tsx server.ts` will fail** because Node tries to exec the whole string as a binary name; users must pass the command as the binary and use separate args.

`call` — Parses `key=value` positional args with `JSON.parse` fallback for non-string values. Filters out non-kv args from `rawArgs` by exclusion (fragile; use `--input-json` for complex inputs). Fuzzy match threshold is 4 Levenshtein distance. Same `--command` splitting issue as `list`.

`discover` — Reads all six config files silently (skips on read error). Handles both standard `mcpServers` shape and Goose's `extensions` shape. Source key for project-local `mcp.json` is `mcp-json` (not `project`).

`install` — Six subcommands, all sharing `installServer()` from `shared.ts`. Uses Listr2 for the 4-step task display: resolve path → check duplicate (interactive `@clack/prompts` confirm) → write → verify. The `--args` flag is comma-separated (values with commas are unsupported). The `--env` flag is comma-separated `KEY=VALUE`; values containing `=` are silently truncated (should split on first `=` only). `install goose` writes to the `extensions` key with Goose's expected shape: `{ cmd, args?, env?, enabled: true, type: 'stdio' }`.

`dev inspector` — Has a fundamental bug: the command spawns `serverProcess` (subprocess with piped stdio), then passes `node <file>` to `npx @modelcontextprotocol/inspector` which creates its *own* separate server process. The `serverProcess` is orphaned — the file watcher restarts it but nothing is connected to it. The `--server-port` arg is defined but not used. TypeScript files are incorrectly invoked as `node <file>` instead of `npx tsx <file>`.

---

**Foundation:** Built on the v2 scoped MCP SDK packages — `@modelcontextprotocol/{client,core,node,server,server-legacy}` at `2.0.0-beta.5` — replacing the 1.x `@modelcontextprotocol/sdk`.

**Module format:** ESM throughout (`"type": "module"`).

**Tests:** Vitest. Test files live in `tests/` (not colocated with source).
