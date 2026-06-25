// Verifies that `fastmcp/client` bundles for the browser without pulling in any
// Node built-ins. This is the regression guard for the lazy-import refactor:
// Node-only code (stdio transport, FileTokenStorage, OAuth localhost callback
// server + browser-opener, root-path normalization) must only ever be reached
// through dynamic import() that a browser bundler can map to an empty module.

import { build } from 'esbuild'

// Node built-ins that must NOT end up statically required by the browser bundle.
const FORBIDDEN = [
  'child_process',
  'node:child_process',
  'fs',
  'fs/promises',
  'node:fs',
  'node:fs/promises',
  'http',
  'node:http',
  'https',
  'node:https',
  'os',
  'node:os',
  'net',
  'tls',
  'node:net',
  'node:tls',
  'node:path',
  'node:url',
  '@modelcontextprotocol/sdk/client/stdio.js',
]

let result
try {
  result = await build({
    entryPoints: ['src/client/index.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    // Mirror the package.json "browser" map: Node built-ins resolve to empty
    // modules. A browser bundler (Vite/webpack) does the same via that field.
    // If a forbidden module is reached through a *static* import, esbuild will
    // throw "Could not resolve" here — which is the failure we want to catch.
  })
} catch (err) {
  console.error('Browser bundle failed to build:\n')
  console.error(err.message ?? err)
  process.exit(1)
}

const out = result.outputFiles.map((f) => f.text).join('\n')

// Flag any forbidden specifier that survived as a real static require/import.
const leaked = FORBIDDEN.filter((m) => {
  const q = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(require\\(|from\\s*|import\\s*)["']${q}["']`).test(out)
})

if (leaked.length) {
  console.error('Browser bundle leaked Node built-ins:', leaked)
  process.exit(1)
}

console.log('OK: browser bundle is free of Node built-ins')
