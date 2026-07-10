import { defineConfig } from 'tsup'
import type { Plugin } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  version: string
  dependencies: Record<string, string>
}

const sdkVersion = pkg.dependencies['@modelcontextprotocol/sdk'] ?? 'unknown'

// esbuild can't resolve extensionless sub-path imports from the MCP SDK.
// The wildcard export maps './*' to './dist/esm/*' without '.js'.
// This plugin appends '.js' to deep sub-path imports so esbuild can find them.
const MCP_SDK_NAMED_EXPORTS = new Set([
  '@modelcontextprotocol/sdk/client',
  '@modelcontextprotocol/sdk/server',
  '@modelcontextprotocol/sdk/validation',
  '@modelcontextprotocol/sdk/validation/ajv',
  '@modelcontextprotocol/sdk/validation/cfworker',
  '@modelcontextprotocol/sdk/experimental',
  '@modelcontextprotocol/sdk/experimental/tasks',
])

const mcpSdkPlugin: Plugin = {
  name: 'mcp-sdk-resolve',
  setup(build) {
    build.onResolve({ filter: /^@modelcontextprotocol\/sdk\// }, (args) => {
      if (MCP_SDK_NAMED_EXPORTS.has(args.path)) return undefined
      if (/\.[cm]?js$/.test(args.path)) return undefined
      return build.resolve(args.path + '.js', {
        resolveDir: args.resolveDir,
        kind: args.kind,
      })
    })
  },
}

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
    esbuildPlugins: [mcpSdkPlugin],
    outExtension: () => ({ js: '.cjs' }),
    define: {
      __FASTMCP_VERSION__: JSON.stringify(pkg.version),
      __MCP_SDK_VERSION__: JSON.stringify(sdkVersion),
    },
  },
  {
    // The entrypoint bootstrap is spawned as its own process (by run/inspect/
    // list/call/dev) rather than imported by the CLI bundle, so it's built as
    // a separate sibling file in dist/cli/ instead of being inlined above.
    // It has no dependency on the MCP SDK or the rest of the CLI, so it needs
    // none of the plugins/externals configured for the main cli/index entry.
    entry: { 'cli/entrypoint-runtime': 'src/cli/entrypoint-runtime.ts' },
    format: ['cjs'],
    platform: 'node',
    dts: false,
    clean: false,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    splitting: false,
    outExtension: () => ({ js: '.cjs' }),
  },
])
