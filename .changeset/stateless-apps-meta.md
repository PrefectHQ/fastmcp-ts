---
"@prefecthq/fastmcp-ts": patch
---

Fix MCP Apps on the stateless 2025-era HTTP path (#113). `fetch()` and `run({ transport: 'http', stateless: true })` serve each request on a fresh server instance, so only `initialize` sees the client's capabilities. FastMCP treated every later request as coming from a client without UI support: it removed `_meta.ui` from `tools/list`, `resources/list` and `resources/read`, and replaced UI tool results with a placeholder. When the client's capabilities are unknown, FastMCP now serves the UI metadata and the real tool result. Clients known to lack UI support still get no UI metadata. For those clients a UI tool now keeps its text `content` and drops only `structuredContent`, instead of returning `[UI not available in this client]`. A UI tool that declares an output schema keeps its `structuredContent`.
