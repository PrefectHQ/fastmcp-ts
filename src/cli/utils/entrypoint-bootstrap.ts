import { join } from 'node:path'

// The CLI is bundled to CJS (see tsup.config.ts), so `__dirname` refers to the
// bundle's own output directory (dist/cli/) at runtime — `import.meta.url`
// isn't usable here since esbuild leaves it empty for cjs output.
declare const __dirname: string

/**
 * Absolute path to the bundled entrypoint bootstrap script that `run`,
 * `inspect`, `list`, `call`, and `dev inspector` spawn instead of the user's
 * server file directly (see `src/cli/entrypoint-runtime.ts`). tsup emits it as
 * `entrypoint-runtime.cjs`, a sibling of this bundle's own output file
 * (`dist/cli/index.cjs`), so it's resolved relative to that directory rather
 * than hardcoded.
 */
export function resolveEntrypointBootstrapPath(): string {
  return join(__dirname, 'entrypoint-runtime.cjs')
}

/** Environment variables consumed by the entrypoint bootstrap. */
export function buildEntrypointEnv(spec: {
  filePath: string
  exportName: string
  explicitExport: boolean
}): Record<string, string> {
  const env: Record<string, string> = {
    FASTMCP_ENTRYPOINT_FILE: spec.filePath,
  }
  if (spec.explicitExport) {
    env['FASTMCP_ENTRYPOINT_EXPORT'] = spec.exportName
  }
  return env
}
