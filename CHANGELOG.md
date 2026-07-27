# @prefecthq/fastmcp-ts

## 1.0.0-rc.0

### Major Changes

- f74ddff: `ClientCredentialsOptions` is now a discriminated union.

  The `ClientCredentials` options changed from a single interface to a discriminated union with two members. One member takes a `clientSecret`, with an optional `authMethod` of `client_secret_post` (the default, unchanged) or `client_secret_basic`. The other member takes a `privateKey` and an `algorithm` for `private_key_jwt` (RFC 7523), and it requires an `audience`. The two members are mutually exclusive at compile time.

  This is a breaking type change. Code that added fields to the old interface through declaration merging no longer compiles. Build the options as one of the two union members instead. Existing `clientSecret` configurations keep working, because the shared-secret member matches the old shape.

- f74ddff: FastMCP 1.0 — the 2026-07-28 modern protocol era on version 2 of the MCP TypeScript SDK.

  FastMCP now speaks two protocol eras from one codebase. A server serves both the 2025 legacy era and the 2026-07-28 modern era at the same time. It needs no configuration to do so. A client speaks the legacy era by default, so your 0.x code keeps working. You opt into the modern era per connection when you are ready.

  This release moves the library onto version 2 of the official MCP TypeScript SDK — the scoped `@modelcontextprotocol/server` and `@modelcontextprotocol/client` packages. FastMCP wraps the SDK, so the change reaches your code only where you imported the SDK directly. The package name and the entry points do not change. You still install `@prefecthq/fastmcp-ts` and import from `@prefecthq/fastmcp-ts/server` and `@prefecthq/fastmcp-ts/client`.

  **Headline features**

  - **Era negotiation.** A client selects the era per connection with `versionNegotiation`. `{ mode: 'auto' }` probes the server with `server/discover` and uses the modern era when the server offers it. `{ mode: { pin: '2026-07-28' } }` requires the modern era. `getProtocolEra()` reports the negotiated era after connect.
  - **Return-value interactivity (`inputRequired`).** A tool asks the caller for input by returning `inputRequired(...)`. The client answers and retries the same call. One handler serves both eras, because a legacy shim turns the return value into a server-to-client request for 2025 clients. This replaces the deprecated `ctx.sample`, `ctx.elicit`, and `ctx.listRoots`.
  - **Server discovery (`server/discover`).** A client reads a server's supported eras and capabilities before it connects.
  - **Resource subscriptions on both eras.** `server.notifyResourceUpdated(uri)` pushes one change signal. The legacy era backs it with `resources/subscribe` and `resources/unsubscribe`. The modern era backs it with a `subscriptions/listen` stream.
  - **Argument completion.** A `complete` callback supplies suggestions for prompt arguments and resource-template variables.
  - **DNS-rebinding protection.** The server validates the `Host` and `Origin` headers on a loopback bind. Configure `dnsRebinding` to protect a routable bind and to silence the warning on an exposed bind.
  - **Loopback default bind.** An HTTP server now binds `127.0.0.1` by default, not `0.0.0.0`. This matches the FastMCP Python project and turns the DNS-rebinding guard on out of the box.
  - **Client auth family.** OAuth adds client-ID metadata documents (`clientMetadataUrl`, CIMD) and RFC 9207 `iss` validation. New strategies ship: `JwtBearerAuth` (RFC 7523), `EnterpriseManagedAuth` (SEP-990), and `AsyncHeaderAuth`. Step-up authorization answers a `401` raised after connect.
  - **SSE resumability.** The legacy HTTP transport replays missed events after a dropped connection (SEP-1699).
  - **CLI era flags.** The `fastmcp` CLI gains `--modern` and `--pin <version>` to select the era. An HTTP `--url` negotiates automatically.

  **Request-scoped state and handles**

  `ctx.mintRequestState` and `ctx.requestState` carry signed state across one input-required flow. A modern HTTP request has no session, so the session accessors `ctx.getState`, `ctx.setState`, and `ctx.deleteState` throw a pointed error there and name the request-scoped replacements.

  **Breaking changes**

  The upgrade keeps most 0.x code running. The breaks fall into two groups. A small group applies the moment you upgrade. A larger group applies only when you opt a client into the modern era. The categories are:

  - Error classes and one error code. `McpError` and `ErrorCode` become `ProtocolError` and `ProtocolErrorCode`. Resource-not-found moves from `-32002` to `-32602`.
  - SSE becomes an explicit `legacySSE: true` opt-in. A plain URL connects over Streamable HTTP only.
  - The loopback default bind and the DNS-rebinding guard, as described above.
  - The `CachingMiddleware` default key gains an auth-identity partition, so one caller's cached result no longer reaches another identity.
  - Modern-era changes to session state and to server-initiated requests (`ctx.sample`, `ctx.elicit`, `ctx.listRoots`).

  Read the authoritative, ordered upgrade guide before you upgrade: [Migrating from 0.x](https://github.com/PrefectHQ/fastmcp-ts/blob/main/docs/migration.mdx).

  **0.x enters maintenance**

  The 0.x line enters maintenance with this release. It receives critical fixes only. Plan your move to 1.0 with the migration guide above.

  **Pre-release**

  This is a release-candidate line (`1.0.0-rc.*`), published while the MCP TypeScript SDK is in beta. The SDK dependencies are pinned to an exact beta build. A stable `1.0.0` follows once the SDK reaches general availability.

- f74ddff: Legacy SSE transport: wire-format changes.

  The legacy HTTP+SSE transport changes what it sends on the wire (SEP-1699). Every result event on the legacy HTTP+SSE transport now carries an `id:` field. The server sends priming events when a stream opens. A `GET` request replays the events after the last acknowledged `id`, so a client resumes after a dropped connection. The server answers `400` when the requested anchor is no longer in the replay buffer. The buffer holds a bounded number of recent events per session.

  Code that uses the transport through the FastMCP client needs no change. The client handles the new framing and the replay. Code that parses the raw SSE stream must account for the `id:` field, the priming events, and the `400` on an evicted anchor.

### Minor Changes

- f74ddff: Client auth: step-up authorization now runs after connect.

  A server can raise a `401` after the client connects — for example, when a tool needs a scope that the first token does not carry. The client now answers this challenge with a step-up authorization request. With an interactive OAuth flow configured, the client can open a browser to complete the authorization. In 0.x the client failed fast on a post-connect `401` instead.

  The client retries at most twice, and concurrent calls share one authorization request. A client that must stay non-interactive — a headless or automated client — must configure a non-interactive auth strategy, so a post-connect challenge does not try to open a browser.

### Patch Changes

- f74ddff: `client_secret_basic`: credentials use RFC 6749 §2.3.1 encoding.

  The `client_secret_basic` method percent-encodes the client id and the client secret before it builds the HTTP Basic `Authorization` header, as RFC 6749 §2.3.1 requires. A space becomes `%20`. Many clients in the ecosystem instead Base64-encode the raw values. The two agree for a secret that holds only unreserved characters. They differ for a secret that holds reserved or special characters, sent to an authorization server that does not form-decode the header.

  If your secret holds special characters and the authorization server rejects the request, confirm that the server decodes the Basic header per RFC 6749 §2.3.1.

- f74ddff: Legacy-HTTP sampling, elicitation, and roots requests now ride the in-flight request's stream.

  On a legacy sessionful HTTP connection, `ctx.sample()`, `ctx.elicit()`, and `ctx.listRoots()` raise a server-to-client request. Before this change, the server sent that request on the standalone server-to-client stream. A client opens that stream after `initialize`. The server dropped the request when the stream was not yet open. A client that called a sampling or elicitation tool as its first operation could then wait for its timeout.

  FastMCP now tags each such request with the in-flight tool call's request id. The server sends the request on that tool call's own response stream, which the client already reads. This removes the startup hang window. The stdio and modern paths are unchanged.

- f74ddff: Fix: a modern stdio server no longer advertises `resources.subscribe`.

  A server on stdio in the modern era advertised the `resources.subscribe` capability by mistake. The modern era carries resource change signals over the `subscriptions/listen` stream, not over `resources/subscribe`, so the advertisement was wrong. The server now reports the correct capabilities for the negotiated era. A modern client no longer sees a subscribe capability that the modern era does not use.

## 0.1.0

### Minor Changes

- 7d0a3ce: Add entrypoint-export support to the CLI. `fastmcp run <file>:<export>` and `--file`/`--export` on `inspect`, `list`, and `call` now resolve a named export (or a sync/async factory function returning one) and start or introspect it directly, instead of requiring the file to call `.run()` itself. When no export is given, `default`, `mcp`, `server`, and `app` are auto-detected in that order, mirroring Python FastMCP's entrypoint convention. Files that already start their own server continue to work unchanged.

  Adds `FastMCP.isRunning`, a read-only getter reporting whether `run()`/`connect()` has been called on the instance.

  `fastmcp run` also gains `--host` and `--path` flags (alongside the existing `--transport` and `--port`), setting `MCP_HOST`/`MCP_PATH` for the spawned server the same way `--transport`/`--port` already set `MCP_TRANSPORT`/`MCP_PORT`.

## 0.0.6

### Patch Changes

- 9cbddac: Fix MCP SDK subpath imports used by createProxy transports.
- 9cbddac: Fix MCP SDK subpath imports used by FastMCP run transports.

## 0.0.5

### Patch Changes

- 703bff6: Set up automated release pipeline (Changesets + GitHub Actions + npm Trusted Publishing). No runtime changes.
