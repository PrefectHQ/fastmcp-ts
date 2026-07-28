---
"@prefecthq/fastmcp-ts": minor
---

Add stateless legacy-era HTTP. Set `RunOptions.stateless` or
`FASTMCP_STATELESS_HTTP` and the server serves each legacy HTTP request from a
fresh server and transport: no session registry, incoming `mcp-session-id`
ignored, and no session id issued. Use it behind a load balancer or on
serverless compute, where consecutive requests reach different instances and a
sessionful server answers 404 "Session not found".

Two things to check before you upgrade, not just before you opt in:

- `FASTMCP_STATELESS_HTTP` is a new variable, but if a deployment already
  happens to export it, this release is not a no-op for that deployment. The
  variable was inert before this release; it is now load-bearing, and the
  server flips to stateless mode on upgrade with no code change.
- The variable is read on every transport, including stdio. An unrecognized
  value now aborts startup rather than falling back silently, so a server that
  starts today can fail to start after upgrading, even if it never turns
  stateless mode on.

Stateless mode gives up what a session provides, and says so rather than failing
quietly:

- `ctx.getState`, `ctx.setState`, and `ctx.deleteState` throw a pointed error.
- `ctx.elicit`, `ctx.sample`, and `ctx.listRoots` throw a pointed error. Client
  capabilities are negotiated once at `initialize` and the client replies on a
  separate request, and neither survives per-request serving.
- `inputRequired({ inputRequests })` throws for the same reason. Only
  `inputRequired({ requestState })`, with no `inputRequests`, still works — but
  not because the client retries anything. The SDK re-enters your handler
  itself, in-process, inside the same HTTP request, pacing each round with a
  short sleep (about 250ms). That holds the request open longer for every
  round, and it gives up after a bounded number of rounds (8 by default) — so
  it suits a handler that can finish on its own schedule, not one waiting on
  an external event.
- `resources.subscribe` is not advertised, and both subscribe methods are
  rejected.
- `GET` and `DELETE` return 405, and SSE resumability is off.
- `ctx.onClose` never fires.

Sessionful mode is unchanged and remains the default, and the modern
(2026-07-28) era was already stateless.
