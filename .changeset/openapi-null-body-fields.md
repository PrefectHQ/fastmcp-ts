---
"@prefecthq/fastmcp-ts": patch
---

OpenAPI tools now send an explicit `null` for a JSON body property whose schema allows `null`, so a tool call can clear a field. Other `null` arguments are still omitted, matching Python FastMCP.
