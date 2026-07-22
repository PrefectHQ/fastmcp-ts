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
describe('buildInspectorServerArgs', () => {
  it('runs a JS server file through node', () => {
    expect(buildInspectorServerArgs({ filePath: '/abs/server.mjs', isTypeScript: false })).toEqual([
      'node',
      '/abs/server.mjs',
    ])
  })

  it('runs a TypeScript server file through npx tsx', () => {
    expect(buildInspectorServerArgs({ filePath: '/abs/server.ts', isTypeScript: true })).toEqual([
      'npx',
      'tsx',
      '/abs/server.ts',
    ])
  })
})
