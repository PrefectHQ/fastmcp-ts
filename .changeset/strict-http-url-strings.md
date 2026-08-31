---
"@prefecthq/fastmcp-ts": patch
---

Validate URL string transport inputs against http/https schemes. A string passed to `Client` (or a `url` entry in an `mcpServers` config) that is not a valid `http:` or `https:` URL now fails fast with a clear error that points at `StdioTransport` for local scripts, instead of a bare `Invalid URL` TypeError or a doomed fetch against a non-HTTP scheme. Hardens the client against the transport-inference pitfall found in upstream python fastmcp, where a script path string could be silently executed; fastmcp-ts never executed strings, and now rejects them explicitly.
