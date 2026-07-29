---
"@prefecthq/fastmcp-ts": minor
---

Add `--format fastmcp` to `fastmcp inspect`. The flag emits a snake_case manifest with the same field set the Python FastMCP CLI produces for its `--format fastmcp`, so cross-language consumers (Horizon) can parse one manifest shape from both stacks. The default `--json` output is unchanged.
