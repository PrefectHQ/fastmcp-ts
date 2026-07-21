/**
 * Multi Round-Trip Requests (MRTR) — protocol revision 2026-07-28.
 *
 * On the modern era, servers can no longer send server-initiated requests
 * (sampling, elicitation, roots) mid-call — there is no server→client channel.
 * Instead, a `tools/call`, `prompts/get`, or `resources/read` handler that needs
 * more input from the client returns `inputRequired({ ... })`. The client
 * fulfils the embedded requests and retries the original call with
 * `inputResponses` and an echoed `requestState`.
 *
 * These are thin re-exports of the SDK's own generic, already well-designed
 * primitives — fastmcp-ts adds no behavior on top. See `McpContext.inputResponses`
 * / `McpContext.requestState()` / `McpContext.mintRequestState()` for how a
 * handler reads and mints state through fastmcp's own context, and
 * `FastMCPOptions.requestState` / `FastMCPOptions.inputRequired` for server-wide
 * configuration.
 *
 * Handlers written with `inputRequired(...)` work unchanged on legacy (2025-era)
 * connections too: the SDK's legacy shim fulfils them via real server→client
 * requests and re-enters the handler, so this is a write-once, serve-both-eras
 * pattern — `ctx.elicit()` / `ctx.sample()` / `ctx.listRoots()` remain available
 * for legacy-only code, but throw a clear error naming this replacement when
 * called on a modern-era request.
 */
export { inputRequired, acceptedContent, inputResponse, isInputRequiredResult } from '@modelcontextprotocol/server'
export type {
  InputRequiredResult,
  InputRequiredSpec,
  InputRequest,
  InputRequests,
  InputResponse,
  InputResponses,
  InputResponseView,
} from '@modelcontextprotocol/server'
