---
"@prefecthq/fastmcp-ts": minor
---

`ctx.clientCapabilities` exposes the capabilities the client declared, so a handler can check for support, such as URL-mode elicitation, before it asks. This matches Python FastMCP's `ctx.session.client_capabilities`.

MCP Apps metadata is now gated correctly on stdio 2026-07-28 connections. Before, a client there that did not declare the UI extension still received UI metadata.
