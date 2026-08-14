---
"@prefecthq/fastmcp-ts": patch
---

`createOpenAPIServer` fixes for three generation bugs:

- Body fields listed in the body schema's `required` are now marked required in the tool input schema even when the requestBody itself is optional (#82).
- A single body field is now JSON-wrapped (`{"body": "..."}` instead of the bare value) when the body schema is object-like, e.g. an `allOf` composition without an explicit `type: object` (#83).
- Generated output schemas no longer carry `format` keywords, so structured results are not rejected when the upstream API returns values like `""` for an unset `format: uri` field (#84).
