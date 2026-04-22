import { existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'

export interface FileSpec {
  filePath: string
  exportName: string
  isTypeScript: boolean
}

export function parseFileSpec(spec: string): FileSpec {
  const colonIdx = spec.lastIndexOf(':')
  let filePart: string
  let exportName: string

  if (colonIdx > 1) {
    filePart = spec.slice(0, colonIdx)
    exportName = spec.slice(colonIdx + 1) || 'default'
  } else {
    filePart = spec
    exportName = 'default'
  }

  const filePath = resolve(process.cwd(), filePart)

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const ext = extname(filePath).toLowerCase()
  const isTypeScript = ext === '.ts' || ext === '.tsx' || ext === '.mts'

  return { filePath, exportName, isTypeScript }
}
