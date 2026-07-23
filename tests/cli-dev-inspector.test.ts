import { describe, it, expect } from 'vitest'
import { buildInspectorServerArgs } from '../src/cli/commands/dev/inspector.js'

// Regression test for the `dev inspector` invocation bug: the CLI used to pass
// `--server "<cmd>"` to `npx @modelcontextprotocol/inspector`, but inspector
// 1.0 repurposed `--server <name>` to select a server from a `--config` file.
// Running that composed invocation now fails immediately with
// "--server requires --config to be specified" (verified manually against the
// published inspector). The fix passes the server's command and args as
// trailing positional arguments instead, matching the inspector's documented
// CLI contract (`npx @modelcontextprotocol/inspector node file.js`).
//
// Since the entrypoints feature, the spawned target is the entrypoint
// bootstrap, not the user's file — the user's file travels in the entrypoint
// env (FASTMCP_ENTRYPOINT_FILE). The runner still follows the USER file's
// type: tsx is required for the bootstrap to import a TypeScript entrypoint.
const BOOTSTRAP = '/abs/dist/cli/entrypoint-runtime.cjs'

describe('buildInspectorServerArgs', () => {
  it('runs the bootstrap through node for a JS server file', () => {
    expect(buildInspectorServerArgs({ isTypeScript: false }, BOOTSTRAP)).toEqual([
      'node',
      BOOTSTRAP,
    ])
  })

  it('runs the bootstrap through npx tsx for a TypeScript server file', () => {
    expect(buildInspectorServerArgs({ isTypeScript: true }, BOOTSTRAP)).toEqual([
      'npx',
      'tsx',
      BOOTSTRAP,
    ])
  })
})
