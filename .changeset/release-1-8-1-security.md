---
'@prefecthq/fastmcp-ts': patch
---

Security update: require `@modelcontextprotocol/server` and `@modelcontextprotocol/server-legacy` 2.3.1 or later. The previous range (`^2.0.0`) allowed versions with these advisories:

- GHSA-jm63-cq47-j5jp (high): shared transport or server instances delivered one HTTP client's messages to another.
- GHSA-46jr-4wx8-v453 (high): one HTTP request within the default size limit could exhaust server memory during validation.
- GHSA-rvq5-wwqv-78pq (medium): server bearer authentication accepted tokens issued for another service.

The published CLI inlines its dependency tree, so it now ships the patched SDK (2.0.0 -> 2.3.1, #126, #128).

Also bumps launch-editor 2.14.1 -> 2.14.2 (#124), vite 8.3.0 -> 8.3.4 (#125), and markdown-it 14.3.2 -> 14.3.3 (#127) for security fixes. These are dev-only and do not affect the published package.
