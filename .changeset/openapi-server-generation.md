---
'@prefecthq/fastmcp-ts': minor
---

Add `createOpenAPIServer()`: generate a complete MCP server from any OpenAPI 3.0/3.1 specification (#60). Every operation becomes a tool (or resource/resource template via `routeMaps`) whose input schema merges path/query/header/cookie parameters with the request body, and whose handler calls the described HTTP endpoint. Generation is contract-compatible with Python FastMCP's `FastMCP.from_openapi`: component names, schemas, wrap markers, and route-map semantics match, pinned by Python-generated parity snapshots in the test suite. Supports YAML or JSON spec input, custom HTTP client configuration (base URL, default headers, async auth headers, custom fetch, timeout), `routeMapFn`/`componentFn` customization hooks, `names` overrides, global tags, and `validateOutput: false` for permissive output schemas. Zero new dependencies; generated servers run with `npx fastmcp run server.ts`.
