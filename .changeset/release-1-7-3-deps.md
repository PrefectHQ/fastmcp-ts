---
"@prefecthq/fastmcp-ts": patch
---

Update bundled dependencies. The published CLI inlines its dependency tree, so these bumps change the shipped artifact:

- @hono/node-server 1.19.14 -> 1.19.17 (#108)
- ip-address 10.4.0 -> 10.7.2 (#106)

Also bumps undici 7.29.0 -> 7.30.0 (#109) and markdown-it 14.2.0 -> 14.3.2 (#107), which are dev-only and do not affect the published package.
