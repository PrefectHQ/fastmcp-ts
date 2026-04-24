import type { ModelPreferences } from '@modelcontextprotocol/sdk/types.js'
import type { SamplingHandler } from '../handlers.js'

export type { SamplingHandler }

/**
 * Resolve a concrete model name from the server's modelPreferences.
 * A plain string always uses that model; a function inspects the preferences.
 */
export type ModelSelector = string | ((prefs: ModelPreferences | undefined) => string)

/** Called with each text token as it is streamed from the provider. */
export type OnTokenCallback = (token: string) => void

export interface SamplingAdapterOptions {
  /** Override or replace the model selection logic. */
  modelSelector?: ModelSelector
  /** Fired for each streamed text token. Tool-use deltas are not surfaced. */
  onToken?: OnTokenCallback
}

/** Implemented by all sampling adapters. */
export interface SamplingAdapter {
  asHandler(): SamplingHandler
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function resolveModel(
  prefs: ModelPreferences | undefined,
  selector: ModelSelector | undefined,
  defaultModel: string,
): string {
  if (!selector) {
    return prefs?.hints?.[0]?.name ?? defaultModel
  }
  if (typeof selector === 'string') return selector
  return selector(prefs)
}
