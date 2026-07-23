---
"@prefecthq/fastmcp-ts": major
---

FastMCP 1.0 — the 2026-07-28 modern protocol era on version 2 of the MCP TypeScript SDK.

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
