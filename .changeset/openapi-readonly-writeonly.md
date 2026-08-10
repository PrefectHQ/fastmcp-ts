---
"@prefecthq/fastmcp-ts": minor
---

`createOpenAPIServer` now omits `readOnly` properties from tool input schemas and `writeOnly` properties from tool output schemas, following OpenAPI access-mode semantics. Removed names are also pruned from the corresponding `required` lists.
