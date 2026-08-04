---
'@prefecthq/fastmcp-ts': patch
---

Attach `_meta.ui` (CSP, permissions, domain, prefersBorder) to every `resources/read` content item for UI-capable clients, matching `resources/list`. SEP-1865 hosts build the sandboxed iframe's CSP from the read response, so the metadata must be present there; previously it appeared only on list entries (#61). `ResourceResult` content items now accept an optional `_meta` field; a handler-provided `_meta.ui` overrides the resource's declared `ui` config for that item.
