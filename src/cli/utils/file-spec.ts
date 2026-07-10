import { existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'

export interface FileSpec {
  filePath: string
  /** Export name to resolve. Meaningless when `explicitExport` is false — the
   *  loader auto-detects a conventional export name in that case. */
  exportName: string
  /** True when the user specified an export name via `file:export` colon syntax
   *  or an explicit `--export` flag. False when only a file path was given, in
   *  which case the entrypoint loader falls back to auto-detection. */
  explicitExport: boolean
  isTypeScript: boolean
}

export function parseFileSpec(spec: string, exportOverride?: string): FileSpec {
  const colonIdx = spec.lastIndexOf(':')
  let filePart: string
  let exportName: string
  let explicitExport: boolean

  if (colonIdx > 1) {
    filePart = spec.slice(0, colonIdx)
    exportName = spec.slice(colonIdx + 1)
    explicitExport = exportName.length > 0
    if (!explicitExport) exportName = 'default'
  } else {
    filePart = spec
    exportName = 'default'
    explicitExport = false
  }

  // An explicit --export flag takes precedence over the colon syntax.
  if (exportOverride) {
    exportName = exportOverride
    explicitExport = true
  }

  const filePath = resolve(process.cwd(), filePart)

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const ext = extname(filePath).toLowerCase()
  const isTypeScript = ext === '.ts' || ext === '.tsx' || ext === '.mts'

  return { filePath, exportName, explicitExport, isTypeScript }
}
