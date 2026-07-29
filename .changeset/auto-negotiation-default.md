---
"@prefecthq/fastmcp-ts": patch
---

Version negotiation now defaults to `{ mode: 'auto' }` everywhere — the client probes once with `server/discover` at connect, uses the modern (2026-07-28) era when the server offers it, and falls back to the plain legacy `initialize` handshake otherwise. This applies to `Client`, `MultiServerClient`, and every connecting CLI command. Pass `versionNegotiation: { mode: 'legacy' }` (or the new CLI `--legacy` flag) for the old probe-free legacy behavior; the CLI `--modern` flag is now a deprecated no-op. `{ pin }` is unchanged.
