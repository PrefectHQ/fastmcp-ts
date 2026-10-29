import { SKILL_LIMITS } from '@modelcontextprotocol/core/ext/skills'
import type { Skill as MCPSkill } from '@modelcontextprotocol/core/ext/skills'
import type { SkillContents, TextResourceContents, BlobResourceContents } from './results'
import type { RequestOptions } from './interfaces'

export function preflightSkill(entry: MCPSkill): void {
  if (entry.resources === 'dynamic') throw new Error(`Skill ${entry.uri} has no static file list to read`)
  const total = entry.resources.reduce((size, file) => size + file.size, 0)
  if (entry.resources.length > SKILL_LIMITS.files || !Number.isSafeInteger(total) || total > SKILL_LIMITS.bytes) {
    throw new RangeError(`A skill may contain at most ${SKILL_LIMITS.files} files and ${SKILL_LIMITS.bytes} bytes`)
  }
}

export function skillFilePath(uri: string, root: string): string {
  if (!uri.startsWith(root)) throw new TypeError(`Skill file is outside its directory: ${uri}`)
  const path = uri.slice(root.length).split('/').map((part) => {
    const decoded = decodeURIComponent(part)
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) throw new TypeError(`Invalid skill file path: ${uri}`)
    return decoded
  }).join('/')
  if (/^[a-z]:/i.test(path)) throw new TypeError(`Invalid skill file path: ${uri}`)
  return path
}

function resourceBytes(contents: Array<TextResourceContents | BlobResourceContents>, uri: string): Uint8Array {
  if (contents.length !== 1 || contents[0].uri !== uri) throw new TypeError(`Expected one content block for ${uri}`)
  const content = contents[0]
  if ('text' in content) return new TextEncoder().encode(content.text)
  const binary = atob(content.blob)
  return Uint8Array.from(binary, (value) => value.charCodeAt(0))
}

interface FileRecord { path: string; size: number; hash: string }

function manifestFiles(data: unknown): FileRecord[] {
  if (!data || typeof data !== 'object' || !('files' in data) || !Array.isArray(data.files) || data.files.length === 0) {
    throw new TypeError('Skill manifest must list its files')
  }
  if (data.files.length > SKILL_LIMITS.files) throw new RangeError('Skill manifest exceeds the file limit')
  const files: FileRecord[] = []
  const seen = new Set<string>()
  let total = 0
  const items: unknown[] = data.files
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string'
      || !('size' in item) || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0
      || !('hash' in item) || typeof item.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.hash)) {
      throw new TypeError('Invalid skill manifest file')
    }
    const path = item.path
    if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\\\0]/.test(path)
      || path.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(path)) throw new TypeError(`Invalid or duplicate skill file path: ${path}`)
    seen.add(path)
    total += item.size
    if (total > SKILL_LIMITS.bytes) throw new RangeError('Skill manifest exceeds the byte limit')
    files.push({ path, size: item.size, hash: item.hash })
  }
  if (!seen.has('SKILL.md')) throw new TypeError('Skill manifest must include SKILL.md')
  return files
}

export async function readManifestSkill(
  read: (uri: string, options?: RequestOptions) => Promise<Array<TextResourceContents | BlobResourceContents>>,
  uri: string,
  options?: RequestOptions,
): Promise<SkillContents> {
  if (!uri.endsWith('/SKILL.md')) throw new TypeError('readSkill takes a SKILL.md URI')
  const root = uri.slice(0, -'SKILL.md'.length)
  const manifestUri = root + '_manifest'
  const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(resourceBytes(await read(manifestUri, options), manifestUri)))
  const records = manifestFiles(data)
  const files = []
  const snapshotFiles: Record<string, Uint8Array> = Object.create(null)
  for (const record of records) {
    const fileUri = root + record.path.split('/').map(encodeURIComponent).join('/')
    const contents = await read(fileUri, options)
    const bytes = resourceBytes(contents, fileUri)
    if (bytes.byteLength !== record.size) throw new Error(`Skill file ${record.path} does not match its manifest size`)
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
    const hash = 'sha256:' + [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
    if (hash !== record.hash) throw new Error(`Skill file ${record.path} does not match its manifest digest`)
    snapshotFiles[record.path] = bytes
    const content = contents[0]
    files.push({ uri: fileUri, bytes, verified: true,
      ...(content.mimeType !== undefined ? { mimeType: content.mimeType } : {}),
      ...('text' in content ? { text: content.text } : {}),
    })
  }
  const { Skill } = await import('../skills/skill')
  const snapshot = await Skill.fromFiles(snapshotFiles)
  const segments = root.slice(0, -1).split('/')
  if (decodeURIComponent(segments.at(-1)!) !== snapshot.name) throw new Error('Skill name does not match its URI')
  const skill: MCPSkill = { uri, frontmatter: snapshot.frontmatter, resources: records.map((record) => ({
    uri: root + record.path.split('/').map(encodeURIComponent).join('/'), digest: record.hash, size: record.size,
  })) }
  return { skill, files: files.map((file) => {
    if (file.uri !== uri) return file
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes)
    const body = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
    return { ...file, text, frontmatter: snapshot.frontmatter, body }
  }) }
}
