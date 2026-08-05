---
"@prefecthq/fastmcp-ts": minor
---

Expose the HTTP request carrying each MCP message as per-request context: `ctx.http` gives handlers and middleware the request's headers (web-standard `Headers`), method, and origin-form URL on HTTP transports (`undefined` on stdio). Credential headers (authorization, cookie, proxy-authorization, mcp-session-id) are withheld by default; `ctx.http.redactedHeaderNames` lists what was withheld and `FastMCPOptions.http` (`redactHeaders`/`exposeHeaders`) adjusts the set. Add `RequestVerifier` as an alternative to `TokenVerifier` in `FastMCPOptions.auth`, so trusted-proxy deployments can authenticate from verified request headers (the verifier sees the full wire) while identity keeps flowing through `ctx.auth`, per-tool auth checks, and response-cache partitioning. Add `forwardableHeaders()` for safely forwarding inbound headers to upstream services (strips credentials, hop-by-hop, framing, and `mcp-*` headers).
