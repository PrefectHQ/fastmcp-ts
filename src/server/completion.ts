/**
 * Argument completion (`completion/complete`) — the callback contract shared by
 * prompt arguments and resource-template variables.
 *
 * A completion callback turns a partial value the user has typed into a set of
 * suggestions. It attaches to a single prompt argument (`PromptArgument.complete`)
 * or a single resource-template variable (`ResourceConfig.complete[variable]`);
 * the server routes each `completion/complete` request to the matching callback
 * by the request's `ref` type. See FastMCP `_completePrompt` /
 * `_completeResourceTemplate`.
 *
 * `completion/complete` lives in BOTH protocol eras' wire registries (the legacy
 * 2025-11-25 registry and the modern 2026-07-28 `dispatchRequestSchemas`), so the
 * handler and the `completions` capability are declared unconditionally — no
 * per-era fork, unlike `resources/subscribe`.
 */

/**
 * Optional context the client forwards with a completion request: the values it
 * has already resolved for the prompt's OTHER arguments (or the template's other
 * variables). Use it to narrow suggestions — e.g. offer cities once a country is
 * chosen.
 */
export interface CompletionContext {
  arguments?: Record<string, string>
}

/**
 * The paginated shape a completion callback MAY return for full control over the
 * `total` / `hasMore` hints. Mirrors the wire `CompleteResult.completion` object.
 * Returning a bare `string[]` instead is the common case.
 */
export interface CompletionResult {
  /** Suggested values. Capped to 100 on the wire (the spec's maximum). */
  values: string[]
  /** Total number of matches available, if larger than `values`. */
  total?: number
  /** Whether more matches exist beyond `values`. */
  hasMore?: boolean
}

/**
 * A completion callback. Receives the partial `value` the user has typed and the
 * optional resolved-argument `context`, and returns suggestions — either a bare
 * `string[]` or a {@link CompletionResult} with explicit pagination hints. May be
 * async.
 */
export type CompleteCallback = (
  value: string,
  context?: CompletionContext,
) => string[] | CompletionResult | Promise<string[] | CompletionResult>

/**
 * Normalise a callback's return value into the wire `completion` object.
 *
 * - Bare `string[]` → matches the SDK's own `createCompletionResult`: `values`
 *   sliced to the 100-item wire cap, `total` = the full length, `hasMore` = true
 *   when the callback produced more than 100.
 * - {@link CompletionResult} → the author is managing pagination, so `total` and
 *   `hasMore` pass through exactly as given (omitted when undefined); `values` is
 *   still capped to 100 to satisfy the wire schema.
 */
export function normalizeCompletion(
  raw: string[] | CompletionResult,
): { values: string[]; total?: number; hasMore?: boolean } {
  if (Array.isArray(raw)) {
    return {
      values: raw.slice(0, 100),
      total: raw.length,
      hasMore: raw.length > 100,
    }
  }
  return {
    values: raw.values.slice(0, 100),
    ...(raw.total !== undefined ? { total: raw.total } : {}),
    ...(raw.hasMore !== undefined ? { hasMore: raw.hasMore } : {}),
  }
}

/** The `completion` object for a ref/argument that has no completer: an empty list. */
export const EMPTY_COMPLETION = { values: [] as string[] }
