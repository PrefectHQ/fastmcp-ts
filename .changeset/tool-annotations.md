---
"@prefecthq/fastmcp-ts": minor
---

`ToolConfig` now accepts an optional `annotations` field (`ToolAnnotations`: `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, MCP 2025-03-26). Annotations are forwarded verbatim in `tools/list`, mirroring how resource annotations are already handled. Closes #76.
