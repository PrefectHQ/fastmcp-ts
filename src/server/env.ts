const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

/**
 * Read a boolean environment variable.
 *
 * Returns `undefined` when the variable is unset or empty so the caller can fall
 * through to its own default. Throws when the variable is set to a value that is
 * not recognised.
 *
 * The throw is deliberate. A misspelled or malformed boolean operations variable
 * must fail loudly at startup rather than silently fall back to its default. A
 * typo in FASTMCP_STATELESS_HTTP that goes unnoticed leaves a fleet sessionful
 * when the operator believes it is stateless, and that class of mistake tends to
 * surface later as a partial failure rate in production rather than as an error
 * at deploy time.
 */
export function envBool(name: string): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const normalized = raw.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  throw new Error(
    `[fastmcp] ${name} must be one of 1/true/yes/on or 0/false/no/off (case-insensitive). Received: ${JSON.stringify(raw)}`,
  )
}
