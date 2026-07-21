import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  version: string
  dependencies: Record<string, string>
}

// The v2 MCP SDK packages all share one version number during the beta
// (see migration guide: "As of 2.0.0-beta.1 all v2 packages share one version
// number"), so @modelcontextprotocol/server is representative of the whole set.
const sdkVersion = pkg.dependencies['@modelcontextprotocol/server'] ?? 'unknown'

// v2 packages ship well-formed package.json "exports" maps (explicit
// import/require conditions, fully-extensioned files) for every public
// subpath, so esbuild resolves them natively. Unlike v1, no resolution
// workaround is needed here.

export default defineConfig([
  {
    entry: {
      server: 'src/server/index.ts',
      client: 'src/client/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['cjs'],
    platform: 'node',
    dts: false,
    clean: false,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    splitting: false,
    noExternal: [/.*/],
    outExtension: () => ({ js: '.cjs' }),
    define: {
      __FASTMCP_VERSION__: JSON.stringify(pkg.version),
      __MCP_SDK_VERSION__: JSON.stringify(sdkVersion),
    },
  },
])
