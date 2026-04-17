# fastmcp-ts — project context

TypeScript/Node.js implementation of [FastMCP](https://github.com/PrefectHQ/fastmcp). Covers all three pillars: servers, clients, and apps.

## Key decisions

**Runtime:** Node.js only. No browser support.

**Schema validation:** [Standard Schema](https://standardschema.dev/) (`@standard-schema/spec`) is the validation backbone. This is the shared interface implemented by Zod, Valibot, ArkType, and others — accepting it means callers are not locked to a specific library.

**Server API style:** Options object pattern. No decorators, no classes required. Schema definitions live alongside handler functions in a single configuration object.

**Foundation:** Built on `@modelcontextprotocol/sdk` (official MCP TypeScript SDK) and `@modelcontextprotocol/ext-apps` (apps pillar).

**Module format:** ESM throughout (`"type": "module"`).

**Tests:** Vitest. Test files live in `tests/` (not colocated with source).
