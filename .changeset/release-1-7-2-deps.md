---
"@prefecthq/fastmcp-ts": patch
---

Update bundled dependencies. The published CLI inlines its dependency tree, so these bumps change the shipped artifact:

- hono 4.13.0 -> 4.13.7 (#102)
- qs 6.15.2 -> 6.16.0 (#99)

Also bumps vitest 4.1.8 -> 4.1.11 (#103), which is dev-only and does not affect the published package.
