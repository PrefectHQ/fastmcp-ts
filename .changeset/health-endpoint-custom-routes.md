---
"@prefecthq/fastmcp-ts": minor
---

`run()` can now serve a configurable health endpoint on the HTTP transport (`health: true` or `health: { path, status, body }`, default `GET /healthz` returning `200 ok`), and the new `customRoute()` method registers arbitrary HTTP routes (for example Kubernetes probe or metrics endpoints) on the listener `run()` starts. Route handlers receive a web-standard `Request`, return a `Response`, and own the whole exchange: no MCP auth, no DNS-rebinding guards, and no CORS headers run in front of them.
