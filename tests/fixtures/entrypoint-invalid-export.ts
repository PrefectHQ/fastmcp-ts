/**
 * Fixture for entrypoint resolution error cases: `server` exists but is not a
 * FastMCP instance or factory function, and the file has no other exports
 * that would auto-detect. Used to test:
 *  - explicit `--export server` on an invalid target errors clearly
 *  - auto-detect (no --export) silently falls back to "legacy" behavior
 *    instead of erroring on a coincidental name match
 */
export const server = { not: 'a fastmcp server' }
export const notAFunction = 42
