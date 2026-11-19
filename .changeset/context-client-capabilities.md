---
"@prefecthq/fastmcp-ts": minor
---

`ctx.clientCapabilities` exposes the capabilities the client declared, so a handler can check for support, such as URL-mode elicitation, before it asks. This matches Python FastMCP's `ctx.session.client_capabilities`.
