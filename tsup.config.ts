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

// CLI build: resolves the actual file on disk so esbuild can bundle it.
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

// ESM build: rewrites the import specifier in the output to include '.js'.
// Consuming projects resolve these imports at runtime, and the SDK wildcard
// export './*' maps to './dist/esm/*' (no extension), so bare specifiers like
// 'sdk/types' resolve to 'dist/esm/types' (not found). Adding '.js' gives the
// correct 'dist/esm/types.js'.
const mcpSdkEsmPlugin: Plugin = {
  name: 'mcp-sdk-resolve-esm',
  setup(build) {
    build.onResolve({ filter: /^@modelcontextprotocol\/sdk\// }, (args) => {
      if (MCP_SDK_NAMED_EXPORTS.has(args.path)) return undefined
      if (/\.[cm]?js$/.test(args.path)) return undefined
      return { path: args.path + '.js', external: true }
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
    esbuildPlugins: [mcpSdkEsmPlugin],
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
])
