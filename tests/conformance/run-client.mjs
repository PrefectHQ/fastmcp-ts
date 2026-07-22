/**
 * Local runner for `npm run conformance:client`.
 *
 * Runs the official MCP conformance suite in client mode against the
 * everything-client fixture (spawned from source via tsx — no build):
 *   1. the non-auth core client scenarios, each by name, and
 *   2. the `core` suite filtered to the draft (2026-07-28-era) revision via
 *      `--spec-version draft`.
 *
 * The committed baseline (conformance-baseline.yml) is applied so known failures
 * pass while new regressions fail. The conformance tool version is pinned for
 * reproducibility. Dependency-free Node.
 *
 * Scope (verified against @modelcontextprotocol/conformance 0.1.16):
 *   - Client mode has no `active` suite; its `core` analog also bundles the
 *     OAuth `auth/*` scenarios. This sampling+elicitation fixture configures no
 *     OAuth, so those scenarios cannot pass and would be permanent baseline
 *     entries. To keep the baseline burnable-to-empty, we enumerate the four
 *     non-auth core scenarios instead. Adding OAuth conformance is a named W9
 *     follow-up (an OAuth-configured client driver + the `auth`/`metadata`
 *     suites) — see conformance-baseline.yml.
 *   - `--spec-version 2026-07-28` is rejected; `draft` is the newest-revision
 *     tag. No core scenario is draft-tagged, so run #2 executes 0 scenarios
 *     today; it is wired now to pick up future draft client scenarios.
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
for (const scenario of CORE_SCENARIOS) {
  anyFailed =
    (await runConformance(['client', '--command', command, '--scenario', scenario, ...baselineArgs])) || anyFailed
}
// Draft filter: core suite, draft revision only (0 scenarios in 0.1.16).
anyFailed =
  (await runConformance(['client', '--command', command, '--suite', 'core', '--spec-version', 'draft', ...baselineArgs])) ||
  anyFailed

process.exit(anyFailed ? 1 : 0)
