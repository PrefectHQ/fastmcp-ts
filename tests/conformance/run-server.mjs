/**
 * Local runner for `npm run conformance:server`.
 *
 * Boots the everything-server fixture over HTTP (from source via tsx — no
 * build), waits for it to report readiness, then runs the official MCP
 * conformance suite against it twice:
 *   1. the default `active` suite (all non-pending server scenarios), and
 *   2. the same suite filtered to the draft (2026-07-28-era) revision via
 *      `--spec-version draft`.
 *
 * The committed baseline (conformance-baseline.yml) is applied so known
 * failures pass while new regressions fail. The conformance tool version is
 * pinned for reproducibility. Dependency-free Node.
 *
 * Notes on the draft filter (verified against @modelcontextprotocol/conformance
 * 0.1.16): `--spec-version 2026-07-28` is rejected ("Unknown spec version";
 * valid: 2025-03-26, 2025-06-18, 2025-11-25, draft, extension), so `draft` — the
 * tool's newest-revision tag — is the selector. In 0.1.16 no server scenario is
 * draft-tagged, so run #2 executes 0 scenarios today; it is wired now so it
 * picks up 2026-07-28/draft server scenarios automatically when the tool adds
 * them (or the pin is bumped).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CONFORMANCE = '@modelcontextprotocol/conformance@0.1.16'
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const fixture = join(here, 'everything-server.ts')
const baseline = join(repoRoot, 'conformance-baseline.yml')
const PORT = process.env.PORT ?? '39750'
const url = `http://127.0.0.1:${PORT}/mcp`

const baselineArgs = existsSync(baseline) ? ['--expected-failures', baseline] : []

/** Runs one conformance invocation; resolves true when it exits non-zero. */
function runConformance(args) {
  return new Promise((resolve) => {
    console.log(`\n> npx ${CONFORMANCE} ${args.join(' ')}\n`)
    const child = spawn('npx', ['--yes', CONFORMANCE, ...args], { stdio: 'inherit' })
    child.on('exit', (code) => resolve(code !== 0))
  })
}

/** Boots the fixture and resolves once it prints its readiness line. */
function bootFixture() {
  const child = spawn('npx', ['tsx', fixture], {
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Reap the detached child before rejecting — the caller's `finally` cannot,
      // because `server` was never assigned when boot times out.
      stopFixture(child)
      reject(new Error('fixture did not become ready within 30s'))
    }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      if (chunk.includes('listening on')) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.on('exit', (code) => reject(new Error(`fixture exited before readiness (code ${code})`)))
  })
}

/** Kills the fixture process group started with detached: true. */
function stopFixture(child) {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

let server
let anyFailed = false
try {
  server = await bootFixture()
  anyFailed = (await runConformance(['server', '--url', url, '--suite', 'active', ...baselineArgs])) || anyFailed
  anyFailed =
    (await runConformance(['server', '--url', url, '--suite', 'active', '--spec-version', 'draft', ...baselineArgs])) ||
    anyFailed
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  anyFailed = true
} finally {
  if (server) stopFixture(server)
}

process.exit(anyFailed ? 1 : 0)
