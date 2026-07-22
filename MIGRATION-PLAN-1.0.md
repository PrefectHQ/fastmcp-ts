# fastmcp-ts 1.0 — MCP 2026-07-28 migration plan

**Status:** proposed · **Branch:** `feat-mcp-2026-07-28-v1` · **Created:** 2026-07-21
**Target:** `1.0.0`, built on MCP TypeScript SDK **v2**, speaking spec revision **2026-07-28**.

This document is the execution plan for moving fastmcp-ts to the 2026-07-28 MCP
specification as a `1.0.0` release, and dropping the v1.x line of the official
TypeScript SDK. It is an internal engineering plan, not a docs-site page. Track
progress by checking the boxes in place.

---

## 1. Background

### 1.1 The spec (2026-07-28)

The 2026-07-28 revision is the largest change to MCP since launch. It finalizes on
**July 28, 2026** (RC locked May 21, 2026). The changes that affect this library:

- **Stateless core.** The `initialize` / `notifications/initialized` handshake is
  removed (SEP-2575). The `Mcp-Session-Id` header and protocol-level session are
  removed (SEP-2567). Protocol version, client info, and client capabilities travel
  in per-request `_meta` (`io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}`).
- **`server/discover`.** A new RPC that advertises supported versions, capabilities,
  and identity. Servers must implement it; clients may probe with it.
- **Multi Round-Trip Requests (MRTR).** Server-initiated requests
  (`sampling/createMessage`, `elicitation/create`, `roots/list`) are replaced by a
  return value: a handler returns `resultType: "input_required"` with `inputRequests`,
  and the client retries the original call with `inputResponses` plus an echoed,
  opaque `requestState` string (SEP-2322, SEP-2260). All results now carry a
  `resultType` field.
- **`subscriptions/listen`.** A single long-lived POST-response stream replaces the
  HTTP GET stream and `resources/subscribe` / `resources/unsubscribe`. Clients opt in
  to `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, and
  `resourceSubscriptions`.
- **Removed utilities.** `ping`, `logging/setLevel`, and
  `notifications/roots/list_changed` are gone. Log level is set per-request via
  `io.modelcontextprotocol/logLevel` in `_meta`; when absent, the server emits no
  `notifications/message` for that request.
- **Required HTTP headers.** Streamable HTTP POSTs require `Mcp-Method` and `Mcp-Name`
  (SEP-2243); the server rejects requests where headers and body disagree
  (`-32020 HeaderMismatch`). Tool args tagged `x-mcp-header` mirror into `Mcp-Param-*`.
- **Cache fields.** List and resource-read results require `ttlMs` and `cacheScope`
  (SEP-2549).
- **Deprecations (annotation-only, 12-month window).** Roots, Sampling, and Logging
  are deprecated (SEP-2577). HTTP+SSE transport and DCR are deprecated.
- **Tasks → extension.** The experimental core Tasks feature is redesigned as the
  official `io.modelcontextprotocol/tasks` extension: `tasks/get` (poll),
  `tasks/update` (client input), `tasks/cancel`; no `tasks/list`; server-directed
  creation via `resultType: "task"` (SEP-2663).
- **Errors.** Resource-not-found moves from `-32002` to `-32602`. New draft codes:
  `HeaderMismatch -32020`, `MissingRequiredClientCapability -32021`,
  `UnsupportedProtocolVersion -32022`.
- **Schemas.** Tool `inputSchema` / `outputSchema` accept full JSON Schema 2020-12;
  `structuredContent` may be any JSON value (SEP-2106).

### 1.2 The SDK (v2 repackaging)

The single `@modelcontextprotocol/sdk` 1.x package (we are on **1.29.0**) is replaced
by the **v2 monorepo** of scoped packages, published at **`2.0.0-beta.5`** (npm
`latest` already points at it). Stable is expected **July 28, 2026** with the spec.
v1.x keeps getting fixes for at least 6 months.

| Package | Role |
|---|---|
| `@modelcontextprotocol/server` | server implementation (`McpServer`, low-level `Server`, `createMcpHandler`, `serveStdio`, `inputRequired`) |
| `@modelcontextprotocol/client` | client implementation (`versionNegotiation`, transports, middleware, response cache) |
| `@modelcontextprotocol/core` | public Zod `*Schema` constants |
| `@modelcontextprotocol/node` | Node HTTP ↔ web-standard adapter (`toNodeHandler`, `NodeStreamableHTTPServerTransport`) |
| `@modelcontextprotocol/express` · `/hono` · `/fastify` | thin framework adapters |
| `@modelcontextprotocol/server-legacy` | frozen v1 copies: SSE server transport, OAuth Authorization Server helpers |
| `@modelcontextprotocol/codemod` | `v1-to-v2` codemod |

Key v2 facts that shape our design:

- Same **Standard Schema** validation backbone we already use.
- **One codebase serves both eras.** `createMcpHandler(factory)` serves 2026-07-28 and,
  by default (`legacy: 'stateless'`), stateless-2025 traffic. `serveStdio(factory)`
  pins the era per connection. A built-in **legacy shim** turns `inputRequired(...)`
  handlers into real server→client requests for 2025-era clients — so handlers are
  written once.
- Handlers use **method strings** (`setRequestHandler('tools/call', ...)`), not Zod
  schemas; the second handler arg is a structured `ctx`, not `extra`.
- Client opts into 2026 via `versionNegotiation: { mode: 'auto' | 'legacy' | { pin } }`;
  `getProtocolEra()` reports the result.
- Renames: `McpError` → `ProtocolError`, `ErrorCode` → `ProtocolErrorCode` /
  `SdkErrorCode`, `StreamableHTTPError` → `SdkHttpError`, `RequestHandlerExtra` →
  `ServerContext` / `ClientContext`.
- **Node 20+**, **Zod ≥4.2.0** (self-converts via `~standard.jsonSchema`).

### 1.3 The conformance harness

The official suite is the backbone of verification: `npx @modelcontextprotocol/conformance`.

- **Server mode** connects to a running server (`--url`) and runs scenarios.
- **Client mode** runs our client (`--command`) against scenario servers.
- `--spec-version 2026-07-28` (or `draft`) selects the era; suites include `active`,
  `draft`, `auth`.
- Per-check **expected-failure baselines** (`--expected-failures baseline.yml`) let CI
  pass on known gaps and fail on regressions or stale entries.
- Ships a composite **GitHub Action** (`modelcontextprotocol/conformance@v0.1.x`).
- The same suite scores the SDK tier system.

### 1.4 "Drop older TypeScript SDKs"

This means removing the `@modelcontextprotocol/sdk` 1.x dependency entirely and
depending only on the v2 scoped packages. It is **independent** of protocol
compatibility: per the decisions below, 1.0 servers still serve 2025-era clients
through the SDK's built-in legacy mode.

---

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Server compat posture | **Dual-era via SDK defaults.** Serve 2026-07-28 natively and 2025-era clients through the SDK legacy mode. No current host breaks on day one. |
| 2 | Deprecated features (Roots/Sampling/Logging) | **MRTR-first, keep legacy paths.** Add first-class `inputRequired`. `ctx.elicit`/`sample`/`listRoots` keep working on legacy-era requests, throw typed errors on 2026-era. Client sampling adapters stay (they power MRTR auto-fulfilment). Mark deprecated in docs where the spec does. |
| 3 | Tasks | **Implement the `io.modelcontextprotocol/tasks` extension in 1.0** (spike-gated; see W5). |
| 4 | OAuth Authorization Server | **Keep the AS on `@modelcontextprotocol/server-legacy/auth`** (a supported interim), mark deprecated in docs, add new spec auth hardening client-side. |

---

## 3. Target architecture

- **Dependencies:** `@modelcontextprotocol/{server,client,core,node}` plus
  `@modelcontextprotocol/server-legacy` (only for the frozen OAuth AS router). Remove
  `@modelcontextprotocol/sdk`. Keep `express` for OAuth routes; the MCP endpoint
  becomes fetch-based.
- **Server HTTP:** one pipeline. `isLegacyRequest(req)` routes: legacy → a **sessionful**
  2025 transport from `@modelcontextprotocol/node` (preserves today's session state and
  the live session the legacy shim needs for elicitation/sampling); modern →
  `createMcpHandler(factory, { legacy: 'reject' })` via `toNodeHandler`. A fresh server
  is built per modern request (matches the existing `_makeServer()` pattern).
- **Server stdio:** `serveStdio(() => this._makeServer())`; era pinned per connection.
- **State:** `getState` / `setState` stays for stdio and legacy HTTP sessions; on modern
  requests it throws a pointed error. New `ctx.requestState<T>()` +
  `FastMCPOptions.requestState` wired to `createRequestStateCodec` (HMAC-sealed).
  Document the server-minted-handle pattern as the primary answer.
- **Interactivity:** new first-class `inputRequired(...)` return type (escape hatch
  alongside `ToolResult`) + `ctx.inputResponses` readers (`acceptedContent`,
  `inputResponse`). Written once, serves both eras via the legacy shim.
- **Client:** `versionNegotiation` surfaced (default `'auto'` for HTTP; `'legacy'` +
  explicit flag for CLI-spawned stdio, per SDK probe-stall guidance); `getProtocolEra()`;
  era-aware `ping` / `setLogLevel` / `subscribeResource`; sampling/elicitation handlers
  power MRTR auto-fulfilment; adapters unchanged.

---

## 4. Workstreams

Each workstream owns its own doc updates (see W10 for the cross-cutting docs pass).

### W0 — Groundwork (blocks everything)

- [x] **Update writing guidelines** for user-facing text (ASD-STE100) —
  `.claude/skills/writing-documentation/SKILL.md`. *(Done as the first step of this branch.)*
- [ ] Pin all v2 packages to one exact beta (`2.0.0-beta.5`); remove
  `@modelcontextprotocol/sdk` from `package.json`.
- [ ] Run `npx @modelcontextprotocol/codemod@beta v1-to-v2 .`; sweep `@mcp-codemod-error`
  markers; run the formatter it prints.
- [ ] Manual renames the codemod flags: `McpError`→`ProtocolError`,
  `ErrorCode`→`ProtocolErrorCode`/`SdkErrorCode`, `StreamableHTTPError`→`SdkHttpError`,
  `RequestHandlerExtra`→`ServerContext` (src/server/FastMCP.ts, src/server/middleware.ts,
  src/server/tool.ts, src/client/*).
- [ ] Handler registration: schema-based `setRequestHandler(Schema, …)` → method strings
  (src/server/FastMCP.ts:281–729).
- [ ] `extra.*`→`ctx.*` remap: `requestId`→`ctx.mcpReq.id`, `authInfo`→`ctx.http?.authInfo`,
  `_meta`→`ctx.mcpReq._meta`, `sendRequest`→`ctx.mcpReq.send` (src/server/context.ts, FastMCP.ts).
- [ ] tsup / CLI build: drop the esbuild plugin appending `.js` to v1 SDK subpath imports;
  replace `__MCP_SDK_VERSION__` with the v2 package version(s); confirm the CJS CLI bundle
  builds (v2 ships CJS natively) — tsup.config.ts.
- [ ] `browser` field: update stdio exclusion to `@modelcontextprotocol/client/stdio`;
  the v2 client ships browser shims (package.json:16–39).
- [ ] **Gate:** `tsc --noEmit` clean; unit suite compiles and runs (failures triaged).

### W1 — Server core ✅ (done, committed on this branch)

- [x] Construct low-level `Server` from `@modelcontextprotocol/server`; declare capabilities;
  verify `server/discover` output (tools/resources/prompts listChanged, extensions map).
  Verified via a raw stdio `server/discover` test — capabilities and `supportedVersions`
  come back correctly from the same `_makeServer()` factory used by every era/transport.
- [x] HTTP: replaced both serve paths with a shared hybrid router (`_dispatchHttp` /
  `_dispatchLegacyHttp` / `_getModernHandler` in `src/server/FastMCP.ts`) — `isLegacyRequest`
  classifies each request; legacy routes to the existing sessionful `NodeStreamableHTTPServerTransport`
  code (unchanged behavior, now shared instead of duplicated between the OAuth and
  non-OAuth paths), modern routes to `createMcpHandler(factory, { legacy: 'reject' })` via
  `toNodeHandler`. **Deviation from the plan text above:** CORS now *adds*
  `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` rather than dropping `Mcp-Session-Id` —
  since the locked decision is dual-era serving, legacy sessions (which still use
  `Mcp-Session-Id`) had to keep working. `Mcp-Param-*` is deliberately not listed: browser
  clients skip that header mirroring entirely, so no browser ever needs to send it.
  Verified end-to-end with real HTTP clients (modern pinned to 2026-07-28, and legacy
  default) hitting the same running server/port.
- [x] stdio: swapped `connect(new StdioServerTransport(...))` for
  `serveStdio(factory, { transport })`, passing a `StdioServerTransport(stdin, stdout)`
  built from `RunOptions` as the `transport` option. **Stream-injection override confirmed
  working** — both the existing legacy stdio test (raw `initialize` over `PassThrough`
  streams) and a new modern-era test (raw `server/discover` over the same streams) pass.
  `_stdioServer` tracks the pinned instance for notification fan-out (see below).
- [x] Cache fields: `FastMCPOptions.cacheHints` implemented and wired into the `Server`
  constructor's `cacheHints` option; verified end-to-end via a raw modern `tools/list`
  request asserting `ttlMs`/`cacheScope` on the wire. **`ResourceConfig.cacheHint`
  (per-resource override) not implemented** — the SDK's per-registration cache-hint
  precedence only exists on `McpServer.registerResource`'s metadata; the mechanism
  low-level `Server` users would need (`RESULT_CACHE_HINT_FALLBACK` /
  `attachCacheHintFallback`) is core-internal only, not exported publicly. Per-operation
  hints via `cacheHints` are the full extent of what's cleanly achievable without adopting
  `McpServer`. Documented as a limitation on `FastMCPOptions.cacheHints`.
- [x] Errors: added an explicit test asserting resource-not-found is `-32602`, not the
  old MCP-custom `-32002` (SEP-2164) — was already correct (fastmcp always used
  `ProtocolErrorCode.InvalidParams`), now regression-guarded.
- [x] Deterministic list ordering test added (Map insertion order) for `tools/list`.
- [x] Logging: refactored `createContext()` to delegate `ctx.log`/`reportProgress` to the
  SDK's own `sdkCtx.mcpReq.log` / `sdkCtx.mcpReq.notify` (instead of calling
  `server.sendLoggingMessage` / `server.notification` directly) — this is what actually
  implements the "absent `_meta.logLevel` ⇒ suppressed" gating and per-era request-stream
  routing; reimplementing that ourselves would have duplicated SDK-internal logic. Verified
  a modern-era tool handler calling `ctx.info(...)` completes normally without a client-side
  `logLevel` opt-in (silently suppressed, not an error). `createContext`'s signature changed
  from `(server, requestId, progressToken, auth, sessionState)` to `(server, sdkCtx, auth,
  sessionState)`, deriving `requestId`/`progressToken` from `sdkCtx.mcpReq` internally — one
  now-impossible unit test (`createContext` with an `undefined` requestId) was removed,
  since `sdkCtx.mcpReq.id` is always present by type.
- [x] Proxy/composition (`createProxy`, `mount`): reviewed and simplified. The manual
  `do...while(cursor)` pagination loops in `resyncTools`/`resyncResources`/`resyncPrompts`
  were harmless-but-redundant after v2's client auto-aggregation change (discovered in
  W0) — simplified to single calls. `mount()`/mirroring logic untouched (no SDK surface
  changes affected it).
- **Also discovered and documented (not fixed — flagged as follow-up):**
  `CancellationMiddleware` only reacts to legacy `notifications/cancelled`; modern HTTP
  cancellation is signaled via response-stream closure (`ctx.mcpReq.signal`, present on
  every era), which this middleware doesn't yet observe. A handler keeps running
  server-side to completion on the modern path even though the client is correctly told
  the call was cancelled. Documented in a code comment on the class; unifying the two
  paths is real work (threading `sdkCtx.mcpReq.signal` through `McpContext`) — worth a
  dedicated follow-up rather than folding into W1.
  `getClientCapabilities()`/`getClientVersion()` (used for UI-capability detection) were
  verified by SDK source inspection to work correctly on modern-era instances too (the SDK
  backfills them per-request from the validated envelope) — no code change needed, but
  worth a real test when W4 (Apps) does a fuller audit.

### W2 — MRTR + state ✅ (done, committed on this branch)

- [x] New `src/server/mrtr.ts` re-exports the SDK's `inputRequired`, `acceptedContent`,
  `inputResponse`, `isInputRequiredResult` and the `InputRequired*`/`InputRequest*`/
  `InputResponse*` types (thin re-export — no fastmcp-specific behavior needed on top of
  the SDK's already-generic primitives). `convertResult` (tool.ts), `convertResourceResult`
  (resource.ts), and `convertPromptResult` (prompt.ts) all check `isInputRequiredResult`
  first and pass it through untouched — all three MRTR-capable methods (`tools/call`,
  `resources/read`, `prompts/get`) support the escape hatch, matching the SDK's own
  `InputRequiredResult` doc comment. `_mirrorTool`/`_mirrorPrompt` (composition/mounting)
  updated to recognize and pass through a child's `InputRequiredResult` instead of
  unconditionally wrapping it as a finished result.
- [x] `McpContext`: added `inputResponses`, `requestState<T>()`, and `mintRequestState<T>()`.
  **Era-gating `elicit`/`sample`/`listRoots` required no code change** — verified by SDK
  source inspection that `server.elicitInput`/`createMessage`/`listRoots` already throw a
  clear `SdkError(MethodNotSupportedByProtocolVersion)` on a modern-era request, with a
  message that already names `inputRequired(...)` as the replacement
  (`"Server-to-client requests are not available on protocol revision 2026-07-28: '<method>'
  cannot be sent... Return inputRequired({ ... }) from the handler instead..."`). Added
  `@deprecated` JSDoc on all three pointing to the MRTR replacement.
- [x] `FastMCPOptions.requestState` (`{ key, ttlSeconds?, bind? }`) builds a
  `createRequestStateCodec` instance once, wired into every `_makeServer()`'s
  `ServerOptions.requestState.verify`. `FastMCPOptions.inputRequired` (`maxRounds`,
  `roundTimeoutMs`, `legacyShim`) passed straight through to `ServerOptions.inputRequired`.
  `ctx.mintRequestState()` signs via the codec when configured; falls back to unsigned
  `JSON.stringify` with a console warning when it isn't (matches the SDK's own
  passthrough-when-unconfigured semantics).
- [x] `FileUpload` reworked: removed the vestigial session-state handle-tracking list
  (`SESSION_HANDLES_KEY`) entirely — it served no purpose other than bookkeeping for a
  session-close cleanup that never fires on stateless modern HTTP anyway. The handle
  itself was already the durable, portable, server-minted identifier (the spec's
  explicit-handle pattern) — that part didn't need to change. Added TTL-based expiry
  (`FileUploadOptions.ttlMs`, default 30 min) to the default in-memory storage adapter as
  the real era-agnostic cleanup mechanism; `ctx.onClose` cleanup kept as a best-effort
  early-cleanup optimization for transports that do have a session (stdio, legacy HTTP).
  **`requestState` turned out not to apply here** — FileUpload's flow is entirely
  tool-based (upload → handle → later read/delete), not an elicitation/sampling/roots
  MRTR flow, so there was no "flow phase" for `requestState` to carry. Audited `Approval`
  / `Choice` / `FormInput`: none touch session state at all — already era-agnostic, no
  changes needed.
- [x] New `tests/server/mrtr.test.ts`, 4 tests, all passing:
  1. A tool using `inputRequired(...)` completes a full round-trip on the raw modern wire
     (hand-rolled retry with `inputResponses`) — verified `resultType: 'input_required'`,
     the embedded `elicitation/create` request, and the final result after retry. Required
     discovering that the client must declare the `elicitation` capability in its
     per-request envelope for the embedded request to be permitted
     (`-32021 MissingRequiredClientCapability` otherwise) — the same gate that guards the
     legacy push-style call.
  2. **The identical handler** (same tool registration, zero branching) verified against a
     default (legacy-era) SDK client with an `elicitation/create` handler registered the
     ordinary 2025 way — the SDK's legacy shim transparently bridges the `inputRequired`
     return into a real server-initiated request over the sessionful legacy connection.
     This is the "write once, serve both eras" property working end-to-end, and confirms
     W1's decision to keep the legacy branch sessionful (rather than using
     `createMcpHandler`'s stateless legacy fallback) was necessary for this to work at all.
  3. `FastMCPOptions.requestState` mints a signed `requestState`, and the handler reads
     back the verified, decoded payload via `ctx.requestState<T>()` on retry.
  4. A tampered `requestState` is rejected with the frozen `-32602` error
     (`"Invalid or expired requestState"`) before the handler ever runs.

### W3 — Notifications & subscriptions ✅ (done, committed on this branch)

- [x] Server: `_notifyToolListChanged`/`_notifyResourceListChanged`/`_notifyPromptListChanged`
  now also call `this._modernHandler?.notify.{toolsChanged,resourcesChanged,promptsChanged}()`
  alongside the existing legacy/stdio push (optional chaining — a no-op, not a forced
  creation, until the first modern HTTP request actually builds the handler). Added
  `FastMCPOptions.eventBus` (`ServerEventBus`, re-exported from `fastmcp-ts/server`),
  threaded into `createMcpHandler`'s own `bus` option, for multi-process deployments
  where a `subscriptions/listen` stream and the request that changed the list it cares
  about may land on different processes.
  **`resourceUpdated(uri)` intentionally not wired to anything** — confirmed by grep
  and by three pre-existing `it.todo(...)` markers in `tests/server/resources.test.ts`
  that FastMCP's own server has never implemented `resources/subscribe`/`unsubscribe`
  at all (a separately-tracked feature gap, unrelated to the protocol migration). The
  plumbing (`_modernHandler.notify.resourceUpdated`) is ready for whenever that lands.
- [x] Client: `subscribeResource`/`unsubscribeResource` era-routed in both `Client`
  (src/client/client.ts) and `MultiServerClient` (src/client/multi-server.ts, per
  server — each connected server negotiates its own era independently). Legacy era:
  unchanged `resources/subscribe`/`unsubscribe` RPCs. Modern era: maintains one
  `McpSubscription` (`client.listen({ resourceSubscriptions: [...] })`) per
  subscribed-URI-set, re-opening (`listen()` has no in-place filter update) on every
  subscribe/unsubscribe. `McpSubscription.closed` is handled: `'remote'` (unexpected
  disconnect) triggers an automatic re-listen; `'graceful'` (deliberate server-side
  close) and `'local'` (our own close, including `Client.close()`/`MultiServerClient.close()`
  itself, reordered to close the listen subscription first) are respected with no
  action. **`ClientOptions.listChanged` needed no changes at all** — it was already
  implemented (`_buildListChangedConfig()` already existed and was already passed to
  the SDK client constructor), and its shape already matched our own
  `ListChangedHandler<T>` field-for-field, so it was already era-transparent before
  this workstream started.
  **`MultiServerClient`'s existing gap not addressed**: it never wired
  `onToolsListChanged`/`onResourcesListChanged`/`onPromptsListChanged` at all (only
  `log`/`progress`/`sampling`/`elicitation`) — a pre-existing limitation, not something
  this workstream introduced or was asked to fix.
  **Scope note — pulled forward from W7**: testing the modern-era client code above
  required `ClientOptions.versionNegotiation` passthrough and a public `getProtocolEra()`
  on `Client`, which didn't exist yet (explicitly W7 scope). Added the minimal slice
  needed to make this workstream testable; the rest of W7 (SSE fallback posture,
  in-process modern transport, response cache, `MultiServerClient` per-entry
  `versionNegotiation`, era-aware `ping`/`setLogLevel`) remains for that workstream.
- [x] Tests: `tests/server/subscriptions.test.ts` (new, 4 tests) — modern clients receive
  `list_changed` for tools/resources/prompts registered after connecting, plus a custom
  `FastMCPOptions.eventBus` observing published events (the multi-process hook).
  `tests/client/subscriptions.test.ts` extended with a modern-era describe block
  (4 new tests, mirroring the 4 existing legacy ones) — since FastMCP doesn't implement
  server-side resource subscriptions (see above) and `InMemoryTransport` pairs are
  2025-era only, these exercise the client against a hand-built `createMcpHandler`
  server, the same way the existing legacy tests exercise it against a hand-built
  `Server`. Discovered along the way: the modern listen router only honors a
  `resourceSubscriptions` filter entry when the server's capabilities declare
  `resources.subscribe: true` — the same flag the legacy RPC path gates on, just
  consulted by a different mechanism now.

### W4 — Apps / extensions ✅ (done, not yet committed)

- [x] Move the `io.modelcontextprotocol/ui` advertisement from `initialize` capabilities to
  `server/discover` capabilities (modern), keeping the initialize path (legacy)
  (src/server/FastMCP.ts:269). **Needed no code change** — confirmed by reading the SDK's
  `discoverAdvertisedCapabilities`, which is a pure `{...capabilities}` passthrough of the same
  `getCapabilities()` object `initialize` already uses. Both eras already advertise identically.
- [x] Detect UI capability per request from `ctx.mcpReq.envelope` clientCapabilities.extensions
  (modern) vs handshake caps (legacy); update the graceful-degradation path. **Also needed no
  code change for era-detection itself** — confirmed the SDK's `seedClientIdentityFromEnvelope`
  backfills `server.getClientCapabilities()` per-request from the modern envelope automatically,
  so `server.getClientCapabilities()` (fastmcp's existing check) already returns the right value
  on both eras with zero fastmcp-side branching.
- [x] Drift audit: diff fastmcp's `_meta.ui` shapes (CSP, permissions, visibility) against the
  final SEP-1865 / ext-apps spec; fix divergences. **Fetched the final SEP-1865 spec (Stable,
  2026-01-26) and found real drift**, unrelated to the two items above:
  - The spec requires a UI-capable client's declared extension *value* to include a REQUIRED
    `mimeTypes: string[]` field, and servers SHOULD check
    `mimeTypes.includes('text/html;profile=mcp-app')` — not just check that the extension key is
    present. Fastmcp's three call sites (`FastMCP.ts`, tool listing / tool call graceful
    degradation / resource listing) only did a bare truthy check on the key. Added
    `isUiCapable(clientCapabilities)` (src/server/apps/types.ts) implementing the spec-correct
    check and swapped all three call sites to use it.
  - Symmetrically updated the server's own advertised extension value from `{}` to
    `{ mimeTypes: ['text/html;profile=mcp-app'] }`, announcing what fastmcp can actually serve.
  - Fixed `UiToolMeta.visibility`'s docstring: it said "Defaults to `['model']`" when the spec's
    documented default (when the field is omitted) is `['model', 'app']`. Doc-only fix — the
    runtime default was already correct; only the comment was wrong.
  - **Test fallout**: two existing tests/helpers declared the extension with a bare `{}` value
    (`tests/helpers/createUiTestClient.ts`, `tests/apps/providers.test.ts`'s FileUpload cleanup
    test) — spec-non-compliant declarations that the *old*, looser truthy check happened to
    accept. Updated both to declare `mimeTypes` so they represent genuinely spec-compliant
    UI-capable clients. Added 3 new tests to `tests/apps/apps.test.ts` covering: the server's own
    `mimeTypes` advertisement, a client declaring the extension without `mimeTypes` (correctly
    treated as not UI-capable), and a client whose `mimeTypes` doesn't include the UI MIME type
    (also correctly treated as not UI-capable).
- [x] Tests: 3 new tests in `tests/apps/apps.test.ts` (see above). Full suite: 648/648 passing
  (13 pre-existing `it.todo`, unrelated to this workstream).

### W5 — Tasks extension (spike-gated; must not block core 1.0) ⏸ Deferred to post-1.0 (corrected finding)

**Day-1 timeboxed spike (1 day):** verify on beta.5 that (a) the server can dispatch inbound
`tasks/get|update|cancel` registered via the custom 3-arg `setRequestHandler` form on a
2026-era connection — the SDK excludes `tasks/*` from the 2026 method registry and may answer
`-32601`; and (b) the client can receive `resultType: "task"` without
`SdkError(UnsupportedResultType)`. If blocked, intercept at layers we own (wrap `handler.fetch`
for HTTP; a dispatch shim for stdio; client-side raw `request()` with explicit schemas) and file
SDK issues.

- [x] **Spike run, both named conditions confirmed blocked — but the original write-up of this
  section mis-framed *why*, and has been corrected below.** The first pass concluded "SDK gap /
  bug." That was wrong. The real situation, confirmed by reading the actual 2026-07-28 core spec
  and the separate Tasks extension repo (not just the SDK):

  **Tasks is not a core 2026-07-28 feature at all — it is an optional extension, and that
  extension is still an unfinalized draft.**
  - The core spec (`modelcontextprotocol/modelcontextprotocol`, `schema/draft/schema.ts`,
    `LATEST_PROTOCOL_VERSION = "2026-07-28"`) has no task primitives. `ServerCapabilities.extensions`
    gives exactly one worked example: `"io.modelcontextprotocol/tasks"`. This is architecturally
    identical to the MCP Apps extension (`io.modelcontextprotocol/ui`), which fastmcp already
    implements as a consumer-owned extension. SEP-2577 deliberately slimmed 2026-07-28 core
    further, also deprecating `roots`, `sampling`, `logging`, and `logging/setLevel` — in-session
    long-running work is covered by core MRTR (`input_required` + `requestState`), progress
    notifications, and `subscriptions/listen`; only the durable *call-now, disconnect, fetch-later*
    pattern is extension territory.
  - The extension itself (`modelcontextprotocol/ext-tasks`, tracking **SEP-2663**, an open PR) is
    explicitly labelled **"⚠️ Experimental Extension — not an official extension and may change
    significantly or be discontinued."** No releases. Schema lives under `schema/draft`.
  - Pulling that extension's `schema.ts` (source of truth) gives the actual wire surface: capability
    `io.modelcontextprotocol/tasks`; task creation replies with **`resultType: "task"`**
    (`CreateTaskResult = Result & Task`); methods `tasks/get`, `tasks/update`, `tasks/cancel`;
    notification `notifications/tasks`; `subscriptions/listen` gains a `taskIds` filter field.
  - Checked against SDK 2.0.0-beta.5, live: the beta *does not implement this draft extension*, and
    three of its existing 2026-wire guards happen to collide with the draft's current shape —
    confirmed live against a real server/client pair, not just by reading source:
    - `resultType: "task"` is rejected by the client's 2026 result decoder
      (`SdkError(UNSUPPORTED_RESULT_TYPE)`) — it only accepts `'complete'`/`'input_required'`.
    - `tasks/get` / `tasks/cancel` collide with method names the SDK reserves as **deprecated
      2025-11-25-era vocabulary** (`wire/rev2025-11-25/buildSchemas.ts`), so they're era-gated off
      the 2026 wire in both directions (`-32601` inbound; `SdkError(MethodNotSupportedByProtocolVersion)`
      outbound) — not because the SDK forbids extensions, but because these particular strings
      are already spoken-for as legacy spec method names.
    - `tasks/update` and `notifications/tasks` don't collide with anything and would pass through
      untouched as ordinary consumer-owned extension methods.
  - **This is not an SDK bug.** The reference SDK correctly declines to implement an experimental,
    pre-SEP-merge extension. Implementing it in fastmcp today would mean building against a spec
    that may still change shape, and working around the two real collisions above would require
    intercepting below the SDK's JSON-RPC router/result-decoder on both the client and server, on
    every transport (`handler.fetch` for HTTP, a stdio dispatch shim, raw client-side `request()`)
    — a second, parallel, hand-maintained RPC pipeline running alongside the SDK's own, for a
    still-moving spec target. That is exactly the kind of hand-rolled reimplementation this
    migration otherwise avoids in favor of SDK-native mechanisms.
  - **Correction note:** the original version of this section tested the mechanism as if `tasks/*`
    were core RPC methods and concluded "SDK excludes tasks from the 2026 registry" was itself the
    problem. The registry exclusion is expected and correct — tasks was never in core 2026-07-28 to
    begin with.
- [ ] Advertise `io.modelcontextprotocol/tasks`; honor per-request client capability (never
  return a task to a non-declaring client). — **deferred to post-1.0.**
- [ ] `ToolConfig.task` (`true | { mode: 'optional'|'required', pollInterval, ttl }`), adapted to
  server-directed creation. — **deferred; API shape should be revisited against ext-tasks'
  `Task`/`TaskCreationParams` fields (`ttlMs`, `pollIntervalMs`) once that schema stabilizes,
  rather than the superseded SEP-1686 shape this line originally described.**
- [ ] `TaskStore` interface + in-memory default; durable create-before-respond; statuses
  `working|input_required|completed|failed|cancelled`; `tasks/get`, `tasks/update`
  (inputResponses), `tasks/cancel` (cooperative); `notifications/tasks` over the listen stream.
  — **deferred.** (Status enum matches ext-tasks' `TaskStatus` exactly, so this line was already
  accurate.)
- [ ] Client: task-aware `callTool` (opt-in) — poll loop honoring `pollIntervalMs`, task-handle
  API, `tasks/update` for `input_required`, persistence hook for task IDs. — **deferred.**
- [ ] Align wire shapes with the `modelcontextprotocol/ext-tasks` repo; adopt its conformance
  scenarios when published. — **deferred; this is now the primary gate for revisiting W5** (see
  triggers below).
- [x] **Fallback (pre-agreed): invoked, for the corrected reason above.** Shipping 1.0 without
  tasks. Removed `servers/tasks` from `docs/docs.json`'s nav (the "Advanced Servers" group).
  Rewrote `docs/servers/tasks.mdx` itself, which had described a **superseded** design (SEP-1686
  core-tasks: `task: true`, `TaskStore`, `tasks/result` — none of it ever built, confirmed by grep
  of `src/`) — it now accurately states tasks is a planned, experimental extension deferred
  post-1.0, with a pointer to SEP-2663 / `modelcontextprotocol/ext-tasks`. Kept off-nav either way.
  - **Revisit W5 in a later release when:** SEP-2663 merges/stabilizes, `ext-tasks` cuts a tagged
    release (schema stops living under `schema/draft`), and the reference SDK ships extension-method
    dispatch + `resultType` extensibility that doesn't require bypassing its router/decoder — at
    that point this should look like a normal consumer-owned extension (same pattern as MCP Apps),
    not a workaround.

### W6 — Auth ✅ (done, not yet committed)

- [x] **Server AS: confirmed already correct, no code changes needed.** Verified by direct read of
  `src/server/FastMCP.ts`'s `_runHttpOAuth` (not by trusting a prior report — an exploratory
  sub-agent's first pass on this workstream falsely claimed `src/client/auth.ts` and the auth test
  files didn't exist; re-verified everything below by hand after catching that). `oauthProvider`/
  `oauthProxy` (`src/server/auth/oauth/provider.ts`, `proxy.ts`) already import
  `OAuthServerProvider`/`AuthorizationParams`/`UnsupportedGrantTypeError` from
  `@modelcontextprotocol/server-legacy/auth` (done in an earlier workstream). `_runHttpOAuth` mounts
  `mcpAuthRouter({ provider, issuerUrl, scopesSupported })` — confirmed via the package's own type
  defs that this already advertises RFC 9728 protected-resource metadata (`resourceServerUrl`/
  `resourceName`, defaulting to AS=RS when omitted, which matches this server's combined-role
  deployment) alongside RFC 8414 AS metadata and DCR — no separate `mcpAuthMetadataRouter` needed.
  Express is `5.2.1` (declared and installed); no v4/v5-sensitive code found. RS bearer verification
  is unchanged (`requireBearerAuth({ verifier: oauth.provider })` backed by our own jose/introspection
  verifiers, as planned). Existing `tests/server/auth.test.ts` (886 lines: token validation,
  `WWW-Authenticate`, introspection, DCR, proxy, scope-based auth, per-component auth, multi-source
  auth) passes unchanged — 9 describe blocks, all green.
- [x] **Client hardening — implemented in `src/client/auth.ts`, `browser-oauth.ts`:**
  - **RFC 9207 `iss` validation via `finishAuth(URLSearchParams)`:** the previous code only ever
    extracted `code` from the OAuth callback and called `finishAuth(code)` — the `iss` query
    parameter was silently discarded, so RFC 9207 authorization-response validation never ran.
    Changed `OAuth`'s internal callback plumbing (`waitForCallback()`, `_armCallbackPromise`,
    `_resolveCallback`, `_awaitCallback`) to carry the full `URLSearchParams` from the callback
    instead of a bare code string, and `client.ts`'s reconnect path now calls
    `transport.finishAuth(callbackParams)` — the SDK's preferred overload, which extracts `code`
    and `iss` itself and validates `iss` against the recorded issuer (RFC 9207 §2.4) via
    `validateAuthorizationResponseIssuer` **before** redeeming the code. `BrowserOAuth` (popup
    postMessage handler, `waitForCallback`, `resumeFromRedirect`) and `handleOAuthCallback()` updated
    the same way, so the browser popup/redirect flows carry `iss` through too.
  - **Per-issuer credential keying (SEP-2352):** confirmed via the SDK's own type defs that
    `clientInformation`/`saveClientInformation`/`tokens`/`saveTokens` on `OAuthClientProvider` now
    take an optional `ctx: { issuer }`, and confirmed live (reading `authInternal`'s source) that
    the `auth()` orchestrator always supplies it once discovery resolves the issuer — except the
    per-request bearer-token bridge (`adaptOAuthProvider`), which calls `tokens()` with **no** ctx
    at all and, per the SDK's own doc comment, must still resolve to "the most-recently-saved token
    set." Implemented: `_key(type, issuer?)` now keys by issuer when known, falling back to the
    original `serverUrl`-scoped key when no issuer is known yet (preserves back-compat with the
    pre-SEP-2352 shape and with existing no-ctx test usage); a small "last issuer seen for this
    server" pointer (`_rememberIssuer`/`_lastIssuer`, itself stored under the old serverUrl-scoped
    key) is updated on every `save*` call that receives a `ctx.issuer`, and consulted by the no-ctx
    read paths. `invalidateCredentials` deletes under both the last-known-issuer key and the legacy
    key defensively. `browser-stores.ts` needed **no changes** — it's a plain `KeyValueStore` backend
    (localStorage/IndexedDB), agnostic to key semantics; the keying logic lives entirely in `OAuth`.
  - **`discoveryState()`/`saveDiscoveryState()`: already implemented, no changes needed** — this
    plan line was already satisfied before this workstream started (confirmed by reading the
    existing code and its passing tests).
  - **`InsufficientScopeError` / step-up: already handled for free, no changes needed.** Read the
    SDK's `_stepUpAuthorize` source directly: with the default `onInsufficientScope: 'reauthorize'`
    and a full `OAuthClientProvider` (which `OAuth` is), a `403 insufficient_scope` response makes
    the transport call `auth()` internally with the unioned scope, and — if that requires a fresh
    redirect — throws the **same** `UnauthorizedError` our existing `client.ts` catch block already
    handles for the initial-401 case. `InsufficientScopeError` itself is only thrown when a host
    opts into `onInsufficientScope: 'throw'` or supplies a bare `AuthProvider` with no OAuth
    provider to drive step-up — neither applies to fastmcp's default setup, so no new API surface
    was added for this.
  - **`application_type` in DCR: already free, verified live (not just read).** Ran
    `resolveClientMetadata(oauth)` directly against an `OAuth` instance and confirmed
    `application_type: 'native'` is auto-derived from the loopback `redirect_uris`, exactly as the
    SDK's SEP-837 default describes — no code needed, since `OAuth.clientMetadata` never sets this
    field itself.
  - **Related fix found while verifying the above:** `OAuth.clientMetadata` was explicitly setting
    `grant_types: ['authorization_code']`. Because "a field the consumer set explicitly is never
    overwritten," this **suppressed** the SDK's own SEP-2207 default of
    `['authorization_code', 'refresh_token']` for interactive providers — meaning authorization
    servers that gate refresh-token issuance on the registered grant types would never issue one
    during DCR, even though this class fully supports using a refresh token once present. Removed
    the explicit `grant_types` line entirely so the SDK's default applies; verified live
    (`resolveClientMetadata` now returns both grant types). `response_types: ['code']` was left as
    an explicit, intentional restriction (this library only implements the authorization-code flow).
  - **CIMD (SEP-991) with DCR fallback: implemented as a thin passthrough, confirmed the fallback is
    entirely SDK-native.** Added `OAuthOptions.clientMetadataUrl`, exposed as a readonly
    `clientMetadataUrl` property (the `OAuthClientProvider` interface field), validated eagerly in
    the constructor via the SDK's own `validateClientMetadataUrl()`. Read `authInternal`'s source
    directly: when `clientMetadataUrl` is set **and** the resolved AS metadata advertises
    `client_id_metadata_document_supported`, `auth()` uses the URL as `client_id` and skips DCR
    entirely on its own; when either condition is false, it falls through to the existing DCR path
    unchanged. No orchestration code needed on the fastmcp side beyond exposing the property.
  - **Playwright e2e** (`tests/browser/oauth-e2e.spec.ts`): unchanged and re-run — passes with all
    of the above (the real popup + postMessage + token-exchange + reconnect + `listTools()` flow
    completes end-to-end through the new `URLSearchParams`-based callback plumbing).
- [x] **Not addressed, out of scope for this workstream:** `MultiServerClient` has no OAuth
  interactive-flow handling at all (no `UnauthorizedError` catch, no `_bind()`/issuer plumbing) —
  confirmed by grep, a pre-existing gap. Matches the plan's own W7 item ("`MultiServerClient`:
  per-entry `versionNegotiation`/auth"); left for that workstream rather than expanded here.
- [x] Tests: 12 new tests across `tests/client/auth.test.ts` (issuer-scoped storage / SEP-2352,
  CIMD/`clientMetadataUrl` validation, `iss` capture in the Node callback server) and
  `tests/client/browser-oauth.test.ts` (`iss` through postMessage and `resumeFromRedirect`). Full
  suite: 660/660 passing (13 pre-existing `it.todo`, unrelated). Playwright OAuth e2e: 1/1 passing.

### W7 — Client core ✅ (done, not yet committed)

- [x] `ClientOptions.versionNegotiation` + `getProtocolEra()` — **already done in W3**, pulled
  forward at the time because W3's own subscription tests needed it; re-verified here, unchanged.
  Added `ClientOptions.prior?: PriorDiscovery` (constructor-level, mirroring how
  `versionNegotiation` is already configured, rather than as a per-`connect()`-call param — the
  ref-counted `connect()` is shared across callers, so a per-call verdict would conflict with that
  model) — threaded to `sdkClient.connect(transport, { prior })`. **CLI `--modern`/`--pin` flags and
  an `'auto'`-for-HTTP default are explicitly deferred to W8** ("CLI + examples", the very next
  workstream) — this line originally bundled a CLI concern into a client-library workstream; the
  library capability (`ClientOptions.versionNegotiation`) is fully wired and ready for W8 to expose
  as flags, but no CLI code was touched here.
- [x] Era-aware `ping()`: legacy era sends the `ping` RPC unchanged; modern era calls
  `discover()` (`server/discover`) instead and returns `true` on success — confirmed by reading
  the SDK's 2026 wire registry (from W5's research) that `ping` is absent from it, so the
  unconditional `this._sdk().ping(...)` call would throw `MethodNotSupportedByProtocolVersion` on
  a modern connection; `discover()` is the SDK-native modern equivalent, not a hand-rolled one.
- [x] Era-aware `setLogLevel()`: legacy era sends `logging/setLevel` unchanged; modern era — where
  `logging/setLevel` is deprecated (SEP-2577) and physically absent from the wire registry —
  records the level and threads it into `_meta['io.modelcontextprotocol/logLevel']` on every
  subsequent request via a new `_metaParams()` helper, spread into the params object of every
  request-building call site (`listTools`, `listResources`, `listResourceTemplates`, `readResource`,
  `readResourceRaw`, `subscribeResource`, `unsubscribeResource`, `listPrompts`, `getPrompt`,
  `callTool`, `complete`). **Verified live, not just "doesn't throw"**: built a raw
  `createMcpHandler`-based test server whose `tools/call` handler reads `ctx.mcpReq.envelope`
  (discovered along the way — the server lifts `_meta` off `params` before the handler runs, so a
  registered handler never sees it at `request.params._meta`; the correct read site is the second
  handler argument's `mcpReq.envelope`) and confirmed the key is absent before `setLogLevel()` and
  present with the right value immediately after.
- [x] MRTR auto-fulfilment: `handlers.sampling`/`handlers.elicitation` → SDK handler registration —
  **confirmed already correct**, no changes (capability declaration in `_buildCapabilities()` and
  `setRequestHandler` registration in `_registerHandlers()` both already matched the SDK's expected
  shape). Added `ClientOptions.inputRequired?: InputRequiredOptions` (`autoFulfill`, `maxRounds`),
  passed straight through to the SDK client constructor — the SDK already implements the entire
  auto-fulfilment driver against the *same* `sampling`/`elicitation` handlers this class registers,
  so this was a pure passthrough, not new logic.
- [x] SSE fallback demoted to explicit opt-in: added `ClientOptions.legacySSE` (default `false`).
  A URL whose path indicates SSE (e.g. ends in `/sse`) now throws a clear error pointing at
  Streamable HTTP and the flag, instead of silently connecting over a transport the SDK itself
  marks `@deprecated`; setting `legacySSE: true` connects as before and logs a one-time
  `console.warn`. Threaded through a new shared `TransportResolutionOptions` type across
  `resolveTransport`/`resolveEntryTransport`/`urlToTransport` (previously these only took
  `(input, auth)`).
- [x] In-process transports for modern era: added an optional `_modernFetch?(request, options)`
  hook to the `McpServerLike` duck-type interface, and implemented it on `FastMCP`
  (`_modernFetch` delegates to the same `createMcpHandler`-backed `_getModernHandler().fetch` the
  real HTTP modern path already uses — confirmed via its own type defs that `McpHttpHandler.fetch`
  is exactly `(request: Request, options?) => Promise<Response>`, a pure in-process dispatcher, no
  sockets). Client-side: when an in-process `McpServerLike` input is paired with a **pinned**
  modern `versionNegotiation` (`{ mode: { pin: '2026-07-28' } }`) and the entry exposes
  `_modernFetch`, `resolveTransport`/`resolveEntryTransport` build a `StreamableHTTPClientTransport`
  against a dummy in-process URL whose `fetch` option is adapted `(url, init) =>
  modernFetch(new Request(url, init))`. **Scoped deliberately to pinned mode only, and documented as
  such**: `'auto'`/`'legacy'` modes still go through the existing `connect()` + `InMemoryTransport`
  pair (2025-era only, unchanged) — `_modernFetch` mirrors `createMcpHandler(..., { legacy:
  'reject' })`, so it cannot itself serve a negotiation that might fall back to legacy; building a
  dual-era in-process bridge (routing through the server's *full* HTTP dispatch, which splits
  legacy/modern at the Node request/response layer, not a pure fetch signature) is a materially
  larger undertaking left for a future workstream if in-process `'auto'` negotiation is needed.
  Verified live end-to-end (in-process `FastMCP` server, pinned modern client, `listTools()`
  succeeds, `getProtocolEra()` reports `'modern'`).
- [x] Response cache passthrough (stretch, done): added `ClientOptions.responseCacheStore` /
  `cachePartition` / `defaultCacheTtlMs`, passed straight through to the SDK client constructor —
  the SDK's `InMemoryResponseCacheStore` default and cache-hint handling needed no fastmcp-side
  logic at all.
- [x] `MultiServerClient`: added `MultiServerOptions.versionNegotiation` — **this was missing
  entirely**; `_buildSdkClient()` never passed `versionNegotiation` to the per-server SDK client
  constructor at all, so a `MultiServerClient` could never negotiate modern era on any server,
  regardless of what a caller configured (there was nothing to configure). Applied identically to
  every server in the config (a single option, not per-entry — per-entry auth already existed via
  `McpServerEntry.auth`, but per-entry `versionNegotiation` was judged unnecessary complexity for
  what SEP-2577 conformance actually needs: fan-out to potentially-mixed-era servers, not
  independently-tunable negotiation policy per server). Added `getProtocolEra(serverName)` (new —
  didn't exist before; "era surfaced per server" from the plan had no way to be surfaced at all)
  reading the named sub-client's own negotiated era. Made `ping()` and `setLogLevel()` era-aware
  per sub-client — same fixes as `Client` (`discover()` for modern `ping`; per-server-name
  `_logLevels` map + `_metaParamsFor(serverName)` threaded into the same breadth of call sites) —
  `subscribeResource`/`unsubscribeResource` needed **no changes**, already era-routed per server
  from an earlier workstream.
- [x] Tests: 8 new tests in `tests/client/client.test.ts` (pinned-modern in-process transport,
  era-aware `ping()` on both eras, era-aware `setLogLevel()` on both eras plus a raw-wire
  `_meta`-arrival verification, `inputRequired`/response-cache passthrough sanity), 3 new tests in
  `tests/client/transports.test.ts` (SSE opt-in throw + explicit-opt-in success, replacing the
  old auto-SSE tests), 4 new tests in `tests/client/multi-server.test.ts`
  (`versionNegotiation` legacy-default and pinned-modern fan-out, era-aware `ping()`/`setLogLevel()`
  for a modern sub-client). Full suite: 675/675 passing (13 pre-existing `it.todo`, unrelated).
  Playwright OAuth e2e re-run: 1/1 passing (unaffected, but re-verified since `transports.ts`
  changed).

### W8 — CLI + examples

- [ ] `connect.ts` / `list` / `call` / `inspect`: era flags; work against both eras; map
  `-32020`/`-32021`/`-32022` (src/cli/utils/connect.ts, src/cli/commands/*).
- [ ] Verify `@modelcontextprotocol/inspector` era support for `dev inspector` (already
  known-buggy — fix or document) (src/cli/commands/dev/inspector.ts).
- [ ] Update `examples/kitchen-sink`, `examples/unit-converter`; README quickstart.

### W9 — Verification harness (the backbone)

- [ ] **Conformance fixtures:** `tests/conformance/everything-server.ts` (fastmcp server covering
  tools/resources/prompts/completion/elicitation/logging/apps/tasks) and
  `tests/conformance/everything-client.ts` (drives the fastmcp `Client` from
  `MCP_CONFORMANCE_SCENARIO` / `MCP_CONFORMANCE_PROTOCOL_VERSION`).
- [ ] **Local scripts:** `npm run conformance:server` / `conformance:client` — boot the fixture,
  run `npx @modelcontextprotocol/conformance {server|client}` with suites `active` and `draft`
  (2026-07-28).
- [ ] **Baseline:** committed `conformance-baseline.yml`, per-check entries only, burned down to
  empty before `1.0.0` stable.
- [ ] **CI:** new jobs in `.github/workflows/ci.yml` using `modelcontextprotocol/conformance@v0.1.x`
  (server + client modes); PR-blocking via exit codes; a **nightly scheduled workflow** against
  conformance `main` to catch newly-landed scenarios pre-GA.
- [ ] **Interop matrix (vitest):** fastmcp server × official v2 SDK client in `legacy` / `auto` /
  `pin 2026-07-28`; official `createMcpHandler` + `serveStdio` servers × fastmcp client in all
  three modes; fastmcp × fastmcp both eras.
- [ ] **Wire-level golden tests:** captured JSON-RPC/HTTP transcripts asserting `server/discover`
  shape; per-request `_meta` envelope; `resultType` handling; `inputRequired` round-trip incl.
  byte-exact `requestState` echo; `subscriptions/listen` open/close; required headers and
  `-32020` mismatch rejection; `ttlMs`/`cacheScope` presence; `-32602` for unknown resources.
- [ ] **Era-parametrized unit suites:** rework `tests/helpers/http.ts` (currently hardcodes a
  2024-11-05 `initialize`) into a dual-era harness; run tools/resources/prompts/context suites
  across {stdio-legacy, stdio-modern, http-legacy-sessionful, http-modern}.
- [ ] Existing gates stay green: typecheck, vitest, build, `scripts/test-dist.mjs`,
  `test:browser-bundle`, Playwright OAuth e2e.
- [ ] Optional: run the conformance repo's `tier-check` self-assessment before release.

### W10 — Documentation (Mintlify, ~35 pages)

Docs are a release gate, not an afterthought. A feature does not ship until its page is right.

- [ ] Rewrite affected pages: `docs/servers/running.mdx` (dual-era, hybrid HTTP, `serveStdio`),
  `docs/servers/context.mdx` (era-gated methods, `requestState`), `docs/servers/middleware.mdx`
  (cancellation/caching under both eras), `docs/clients/*` (negotiation, subscriptions, auth
  hardening, caching), `docs/apps/*` (extension negotiation), `docs/servers/auth/*` and
  `docs/clients/auth.mdx` (AS deprecation posture, `iss`, CIMD).
- [ ] New pages: protocol eras & compatibility; input-required (MRTR) guide; state & handles;
  caching; tasks (rewritten to the extension model — the current `docs/servers/tasks.mdx`
  documents an unimplemented 2025 design and must be replaced or pulled per W5).
- [ ] **0.x → 1.0 migration guide** for our users (breaking changes, new APIs, env/behavior).
- [ ] Update `AGENTS.md` (the de-facto internal spec — large diff across server, client, apps,
  CLI, key decisions), `README.md`, and regenerate typedoc API (`npm run docs:api`).
- [ ] `npm run docs:links` (broken-link check) passes; sidebar/TOC shape reviewed per the
  writing-documentation skill.

### W11 — Release engineering

- [ ] Changesets: major → `1.0.0`; ship `1.0.0-rc.*` prereleases while the SDK is in beta (pin
  the exact `2.0.0-beta.x`) — `.changeset/`, RELEASING.md.
- [ ] On SDK GA (~July 28): bump to `^2.0.0`, re-run the full harness, diff the SDK changelog
  beta.5→stable for breaks.
- [ ] Release notes + the 0.x→1.0 migration guide; 0.x deprecation note; publish through the
  existing `prepublishOnly` gates; verify the `fastmcp` bin on a clean install.

---

## 5. Sequencing

Seven days to spec GA (July 28), then stabilization.

| When | Work |
|---|---|
| Days 1–2 | W0 + W1 skeleton compiling on beta.5. W5 spike (timeboxed) in parallel. W9 scaffold: conformance CLI running locally against the branch. |
| Days 2–4 | W2 (MRTR/state), W3 (subscriptions), W7 (client core). Era-matrix harness. |
| Days 4–6 | W4 (apps), W6 (auth), W8 (CLI), W5 build-out per spike outcome. |
| Days 6–7 | W9 full matrix + committed baseline; core W10 pages; **ship `1.0.0-rc.1`** on/around July 28. |
| Week of Jul 28+ | SDK `^2.0.0` bump, baseline burn-down to zero, docs completion, tasks finalization → **`1.0.0` stable** (realistically 1–2 weeks after SDK GA, dominated by tasks scope). |

---

## 6. Risks

1. **SDK beta→stable drift.** The API can still change until July 28 (beta.5 landed wire
   changes the day this plan was written). Pin exact betas; watch releases; keep SDK
   touchpoints behind thin internal adapters.
2. **Tasks without SDK support.** v2 removed its tasks layer, excludes `tasks/*` from the
   2026 method registry, and its client rejects unknown `resultType`. The W5 spike gates
   this; the pre-agreed fallback is shipping 1.0 without tasks.
3. **Legacy-shim limits.** Interactive tools for 2025 HTTP clients need the **sessionful**
   legacy branch (stateless legacy degrades to a capability refusal). The hybrid router is
   load-bearing — test it explicitly.
4. **`serveStdio` stream injection.** Tests rely on stdin/stdout overrides; unverified in v2.
   Fallback: a child-process test harness.
5. **Apps spec drift.** Our UI meta was built from a draft SEP; the final SEP-1865 may differ.
   Audit early (W4).
6. **Conformance draft-suite churn.** Draft scenarios evolve until GA; the nightly job absorbs
   this.

---

## 7. Open questions

- **Client default negotiation mode.** Planned `'auto'` for HTTP and `'legacy'` + explicit flag
  for CLI-spawned stdio (per SDK guidance on probe stalls against unresponsive legacy servers).
  Confirm before W7.
- **SSE client fallback.** Planned: keep as an explicit, deprecated opt-in rather than a silent
  4xx fallback. Confirm before W7.
- **`ping()` on modern era.** Deprecate outright, or repurpose `server/discover` as a liveness
  probe? Decide during W7.
