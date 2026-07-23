/**
 * Local runner for `npm run conformance:client`.
 *
 * Runs the official MCP conformance suite in client mode against the
 * everything-client fixture (spawned from source via tsx — no build):
 *   1. the non-auth core client scenarios, each by name,
 *   2. the 14 core `auth/*` OAuth scenarios, each by name, and
 *   3. the `core` suite filtered to the draft revision via `--spec-version draft`.
 *
 * The committed baseline (conformance-baseline.yml) is applied so known failures
 * pass while new regressions fail. The conformance tool version is pinned for
 * reproducibility. Dependency-free Node.
 *
 * Scope (verified against @modelcontextprotocol/conformance 0.1.16):
 *   - Client mode has no `active` suite. The `--suite core` set is the non-auth
 *     scenarios only; the `auth/*` scenarios are a separate group. Both `--suite`
 *     forms run their scenarios IN PARALLEL, which would race the everything-
 *     client's single fixed OAuth loopback callback port across concurrent auth
 *     scenarios. So every scenario is enumerated BY NAME and run sequentially.
 *   - The everything-client now drives OAuth for `auth/*` scenarios (SEP-2243
 *     header scenarios are main-only and excluded from this pinned run). The 14
 *     enumerated auth scenarios are the `[2025-11-25]`-era core set; the
 *     `[2025-03-26]`, `[draft]`, and `[extension]` auth scenarios are out of
 *     scope for the pinned core run. Two of the 14 are genuine fastmcp debt and
 *     are baselined with reasons — see conformance-baseline.yml.
 *   - `--spec-version 2026-07-28` is rejected; `draft` is the newest-revision
 *     tag. No core (non-auth) scenario is draft-tagged, so run #3 executes 0
 *     scenarios today; it is wired now to pick up future draft client scenarios.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CONFORMANCE = '@modelcontextprotocol/conformance@0.1.16'
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const clientFixture = join(here, 'everything-client.ts')
const baseline = join(repoRoot, 'conformance-baseline.yml')
const command = `npx tsx ${clientFixture}`

// The non-auth core client scenarios the everything-client actually drives.
const CORE_SCENARIOS = ['initialize', 'tools_call', 'elicitation-sep1034-client-defaults', 'sse-retry']

// The 14 core `auth/*` OAuth scenarios ([2025-11-25]-era). Enumerated by name so
// they run sequentially (the OAuth callback port is fixed and cannot be shared
// by parallel scenarios). The everything-client configures an OAuth provider
// from the scenario context; see tests/conformance/everything-client.ts.
const AUTH_SCENARIOS = [
  'auth/metadata-default',
  'auth/metadata-var1',
  'auth/metadata-var2',
  'auth/metadata-var3',
  'auth/basic-cimd',
  'auth/scope-from-www-authenticate',
  'auth/scope-from-scopes-supported',
  'auth/scope-omitted-when-undefined',
  'auth/scope-step-up',
  'auth/scope-retry-limit',
  'auth/token-endpoint-auth-basic',
  'auth/token-endpoint-auth-post',
  'auth/token-endpoint-auth-none',
  'auth/pre-registration',
]

const baselineArgs = existsSync(baseline) ? ['--expected-failures', baseline] : []

/** Runs one conformance invocation; resolves true when it exits non-zero. */
function runConformance(args) {
  return new Promise((resolve) => {
    console.log(`\n> npx ${CONFORMANCE} ${args.join(' ')}\n`)
    const child = spawn('npx', ['--yes', CONFORMANCE, ...args], { stdio: 'inherit' })
    child.on('exit', (code) => resolve(code !== 0))
  })
}

let anyFailed = false
for (const scenario of [...CORE_SCENARIOS, ...AUTH_SCENARIOS]) {
  anyFailed =
    (await runConformance(['client', '--command', command, '--scenario', scenario, ...baselineArgs])) || anyFailed
}
// Draft filter: core suite, draft revision only (0 scenarios in 0.1.16).
anyFailed =
  (await runConformance(['client', '--command', command, '--suite', 'core', '--spec-version', 'draft', ...baselineArgs])) ||
  anyFailed

process.exit(anyFailed ? 1 : 0)
