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

### W2 — MRTR + state

- [ ] Export `inputRequired`, `acceptedContent`, `inputResponse`; teach `convertResult` to
  pass `InputRequiredResult` through untouched (src/server/tool.ts).
- [ ] `McpContext`: add `inputResponses` + `requestState<T>()`; era-gate
  `elicit`/`sample`/`listRoots` (legacy: current behavior; modern: typed error naming the
  replacement) (src/server/context.ts:222–266).
- [ ] `FastMCPOptions.requestState` → `createRequestStateCodec`; `FastMCPOptions.inputRequired`
  knobs (`maxRounds`, `roundTimeoutMs`, `legacyShim`).
- [ ] Rework `FileUpload` provider off session state → server-minted handles via
  `FileStorageAdapter` (+ `requestState` for flow phase) (src/server/apps/providers/FileUpload.ts).
  Audit `Approval` / `Choice` / `FormInput`.
- [ ] Tests: a multi-round flow (phase-switch union) exercised on the modern wire AND via the
  legacy shim on a sessionful legacy connection — assert identical handler behavior.

### W3 — Notifications & subscriptions

- [ ] Server: route `_notify*ListChanged` to `handler.notify.{toolsChanged,…}` (modern) and
  existing notifications (legacy); `resourceUpdated(uri)`; expose a `ServerEventBus` option
  for multi-process deployments.
- [ ] Client: era-route `subscribeResource`/`unsubscribeResource` (legacy RPCs vs
  `subscriptions/listen` `resourceSubscriptions` filter); list-changed handlers via
  `ClientOptions.listChanged`; keep `autoRefresh`/`debounceMs`; handle
  `McpSubscription.closed` (`'graceful'` vs `'remote'` + re-listen)
  (src/client/client.ts:377–513, src/client/multi-server.ts:345–517).

### W4 — Apps / extensions

- [ ] Move the `io.modelcontextprotocol/ui` advertisement from `initialize` capabilities to
  `server/discover` capabilities (modern), keeping the initialize path (legacy)
  (src/server/FastMCP.ts:269).
- [ ] Detect UI capability per request from `ctx.mcpReq.envelope` clientCapabilities.extensions
  (modern) vs handshake caps (legacy); update the graceful-degradation path.
- [ ] Drift audit: diff fastmcp's `_meta.ui` shapes (CSP, permissions, visibility) against the
  final SEP-1865 / ext-apps spec; fix divergences.

### W5 — Tasks extension (spike-gated; must not block core 1.0)

**Day-1 timeboxed spike (1 day):** verify on beta.5 that (a) the server can dispatch inbound
`tasks/get|update|cancel` registered via the custom 3-arg `setRequestHandler` form on a
2026-era connection — the SDK excludes `tasks/*` from the 2026 method registry and may answer
`-32601`; and (b) the client can receive `resultType: "task"` without
`SdkError(UnsupportedResultType)`. If blocked, intercept at layers we own (wrap `handler.fetch`
for HTTP; a dispatch shim for stdio; client-side raw `request()` with explicit schemas) and file
SDK issues.

- [ ] Advertise `io.modelcontextprotocol/tasks`; honor per-request client capability (never
  return a task to a non-declaring client).
- [ ] `ToolConfig.task` (`true | { mode: 'optional'|'required', pollInterval, ttl }`), adapted to
  server-directed creation.
- [ ] `TaskStore` interface + in-memory default; durable create-before-respond; statuses
  `working|input_required|completed|failed|cancelled`; `tasks/get`, `tasks/update`
  (inputResponses), `tasks/cancel` (cooperative); `notifications/tasks` over the listen stream.
- [ ] Client: task-aware `callTool` (opt-in) — poll loop honoring `pollIntervalMs`, task-handle
  API, `tasks/update` for `input_required`, persistence hook for task IDs.
- [ ] Align wire shapes with the `modelcontextprotocol/ext-tasks` repo; adopt its conformance
  scenarios when published.
- [ ] **Fallback (pre-agreed):** if the spike fails or the window closes, ship 1.0 without tasks
  (docs page pulled from nav), land tasks in 1.1.

### W6 — Auth

- [ ] Server AS: re-point `OAuthProvider`/proxy imports to `@modelcontextprotocol/server-legacy/auth`;
  verify express 5 compat; RS bearer verification stays on our jose/introspection verifiers;
  metadata endpoints via `@modelcontextprotocol/server` helpers or existing code
  (src/server/auth/oauth/*, src/server/auth/verifiers/*).
- [ ] Client hardening (2026 conformance opt-ins): pass callback `URLSearchParams` to `finishAuth`
  (RFC 9207 `iss` validation); key persisted credentials by issuer + implement `discoveryState()`;
  handle `InsufficientScopeError` / step-up; declare `application_type` in DCR; add CIMD (SEP-991)
  with DCR fallback (src/client/auth.ts, src/client/browser-oauth.ts, src/client/browser-stores.ts).
- [ ] Browser OAuth stores updated for issuer-keyed storage; Playwright e2e updated.

### W7 — Client core

- [ ] `ClientOptions.versionNegotiation` + `prior` verdict passthrough; expose `getProtocolEra()`;
  defaults `'auto'` (HTTP), `'legacy'` + `--modern`/`--pin` flag (CLI stdio) (src/client/client.ts).
- [ ] Era-aware `ping()` (legacy RPC; modern: `server/discover` liveness or deprecate) and
  `setLogLevel` (legacy RPC; modern: thread per-request `logLevel` into `_meta`)
  (src/client/client.ts:281, :442).
- [ ] MRTR auto-fulfilment: confirm `handlers.sampling`/`elicitation` map onto SDK handler
  registration; expose `inputRequired` client knobs (`autoFulfill`, `maxRounds`).
- [ ] SSE fallback: keep, but demote to explicit opt-in + deprecation warning
  (src/client/transports.ts:206–209).
- [ ] In-process transports: `InMemoryTransport` is 2025-era only; add a `handler.fetch`-backed
  transport path for modern in-process `McpServerLike` inputs; document era implications
  (src/client/transports.ts).
- [ ] Optional (stretch): surface the SDK `responseCache` (`ttlMs`/`cacheScope`-aware) via
  `ClientOptions.cache`.
- [ ] `MultiServerClient`: per-entry `versionNegotiation`/auth; era surfaced per server;
  subscribe/logLevel/ping fan-out era-aware (src/client/multi-server.ts).

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
