# @prefecthq/fastmcp-ts

## 0.1.0

### Minor Changes

- 7d0a3ce: Add entrypoint-export support to the CLI. `fastmcp run <file>:<export>` and `--file`/`--export` on `inspect`, `list`, and `call` now resolve a named export (or a sync/async factory function returning one) and start or introspect it directly, instead of requiring the file to call `.run()` itself. When no export is given, `default`, `mcp`, `server`, and `app` are auto-detected in that order, mirroring Python FastMCP's entrypoint convention. Files that already start their own server continue to work unchanged.

  Adds `FastMCP.isRunning`, a read-only getter reporting whether `run()`/`connect()` has been called on the instance.

  `fastmcp run` also gains `--host` and `--path` flags (alongside the existing `--transport` and `--port`), setting `MCP_HOST`/`MCP_PATH` for the spawned server the same way `--transport`/`--port` already set `MCP_TRANSPORT`/`MCP_PORT`.

## 0.0.6

### Patch Changes

- 9cbddac: Fix MCP SDK subpath imports used by createProxy transports.
- 9cbddac: Fix MCP SDK subpath imports used by FastMCP run transports.

## 0.0.5

### Patch Changes

- 703bff6: Set up automated release pipeline (Changesets + GitHub Actions + npm Trusted Publishing). No runtime changes.
