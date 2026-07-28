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
import type { InputRequiredResult } from '@modelcontextprotocol/server'

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

/**
 * Pointed error thrown when a handler returns `inputRequired({ inputRequests })` while
 * serving a stateless HTTP server (`RunOptions.stateless` / `FASTMCP_STATELESS_HTTP`).
 *
 * Same structural cause as `ctx.elicit()` / `ctx.sample()` / `ctx.listRoots()` — see
 * `SERVER_INITIATED_STATELESS_HTTP_ERROR` in context.ts — but a DIFFERENT constant on
 * purpose: a handler that returns `inputRequired(...)` never called those APIs, so
 * their wording ("Server-initiated requests (ctx.elicit, ctx.sample, ctx.listRoots)...")
 * would name the wrong thing to someone debugging this path. `inputRequests` hits the
 * same wall for its own reason: on legacy connections it is fulfilled by the SDK's
 * legacy shim pushing each embedded request over the server→client channel and awaiting
 * the reply — the exact channel `ctx.elicit()` etc. use, and one a stateless server's
 * per-request `Server` instance does not live long enough to keep open.
 *
 * The bare `inputRequired({ requestState })` form (no `inputRequests`) is NOT affected:
 * it is the supported stateless multi-round-trip pattern (the SDK's legacy shim re-enters
 * the handler in-process, inside the same HTTP request, needing no session) — see
 * docs/concepts/input-required.mdx#the-requeststate-only-pattern.
 */
export const INPUT_REQUESTS_STATELESS_HTTP_ERROR =
  '[fastmcp] inputRequired({ inputRequests }) is not available on a stateless HTTP server ' +
  '(RunOptions.stateless or FASTMCP_STATELESS_HTTP). ' +
  "Fulfilling inputRequests needs a session: the client's reply to each embedded request " +
  'arrives on a separate request, and a stateless server discards its per-request Server ' +
  'before that reply could arrive — the same reason ctx.elicit/ctx.sample/ctx.listRoots ' +
  'are unavailable here. inputRequired({ requestState }), with no inputRequests, remains ' +
  'available — it carries state across rounds without needing a session. ' +
  'Turn stateless off to use inputRequests.'

/**
 * Shared guard called from each of the three result converters (tool.ts convertResult,
 * resource.ts convertResourceResult, prompt.ts convertPromptResult) right after they
 * recognize an `InputRequiredResult`. Throws {@link INPUT_REQUESTS_STATELESS_HTTP_ERROR}
 * when `stateless` is true and `value` carries `inputRequests`; a no-op otherwise —
 * including for the `requestState`-only form, which has no `inputRequests` key. Kept in
 * one place rather than duplicated per converter so the message and the condition can
 * only drift once.
 *
 * `stateless` must be the per-server `opts.stateless` a request handler was built with
 * (the same value threaded into `createContext`), NOT an instance-wide flag — a stdio
 * server can carry `_stateless: true` from `FASTMCP_STATELESS_HTTP` while serving every
 * request sessionfully, because the flag is never passed into `_makeServer` on that path.
 */
export function assertInputRequestsAllowedStateless(
  value: InputRequiredResult,
  stateless: boolean | undefined,
): void {
  // Matches the SDK's own notion of "has inputRequests" (buildInputRequired in
  // @modelcontextprotocol/server's core-internal/src/shared/inputRequired.ts: `spec.inputRequests
  // !== void 0 && Object.keys(spec.inputRequests).length > 0`), not merely `!== undefined`.
  // Without the length check, the degenerate-but-legal `inputRequired({ inputRequests: {},
  // requestState: <token> })` -- legal because `requestState` alone already satisfies the SDK's
  // at-least-one-of-the-two rule -- would throw here even though there is nothing to fulfil and
  // the requestState mechanism carries it through fine: a false positive on the one pattern this
  // guard exists to keep working.
  const hasInputRequests =
    value.inputRequests !== undefined && Object.keys(value.inputRequests).length > 0
  // Unlike the sibling guard in context.ts:312 (same root cause, the server-initiated request
  // APIs), this does not also check `sdkCtx.http !== undefined`. Today `stateless: true` only
  // ever reaches a request handler via `_getStatelessLegacyHandler` (FastMCP.ts), whose single
  // call site is HTTP-only (`_makeServer(new Map(), { stateless: true })` inside the legacy HTTP
  // dispatch path) — stdio never passes `stateless` into `_makeServer` (see this function's doc
  // comment above). A transport check here would therefore be dead code with no way to exercise
  // it; add one only if a future stateless path over a non-HTTP transport is introduced.
  if (stateless && hasInputRequests) {
    throw new Error(INPUT_REQUESTS_STATELESS_HTTP_ERROR)
  }
}
