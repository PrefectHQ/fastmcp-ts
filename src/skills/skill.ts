import { stringify } from 'yaml'
import { skillEntry, SKILL_LIMITS } from '@modelcontextprotocol/server/ext/skills'
import type { Skill as MCPSkill, SkillFrontmatter } from '@modelcontextprotocol/core/ext/skills'

export type SkillFiles = Readonly<Record<string, string | Uint8Array>>

export interface SkillOptions {
  name: string
  description: string
  instructions: string
  files?: SkillFiles
  frontmatter?: Record<string, unknown>
}

export function relativeSkillPath(path: string): string {
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\\\0]/.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`Skill path must be relative POSIX: ${JSON.stringify(path)}`)
  }
  return path
}

export function checkSkillLimits(files: number, bytes: number): void {
  if (files > SKILL_LIMITS.files || bytes > SKILL_LIMITS.bytes) {
    throw new RangeError(`A skill may contain at most ${SKILL_LIMITS.files} files and ${SKILL_LIMITS.bytes} bytes`)
  }
}

/** An immutable snapshot of a SKILL.md and its supporting files. */
export class Skill {
  readonly #files: Record<string, Uint8Array>
  readonly #entry: MCPSkill

  private constructor(files: Record<string, Uint8Array>, entry: MCPSkill) {
    this.#files = files
    this.#entry = entry
  }

  static async create(options: SkillOptions): Promise<Skill> {
    const extra = options.frontmatter ?? {}
    if ('name' in extra || 'description' in extra) throw new TypeError('Pass name and description as Skill options')
    if (options.files && 'SKILL.md' in options.files) throw new TypeError('Pass SKILL.md content as instructions')
    const header = stringify({ name: options.name, description: options.description, ...extra })
    return Skill.fromFiles({ ...options.files, 'SKILL.md': `---\n${header}---\n${options.instructions}` })
  }

  static async fromFiles(files: SkillFiles): Promise<Skill> {
    const snapshot: Record<string, Uint8Array> = Object.create(null)
    let size = 0
    for (const [path, contents] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      relativeSkillPath(path)
      const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : new Uint8Array(contents)
      size += bytes.byteLength
      checkSkillLimits(Object.keys(snapshot).length + 1, size)
      snapshot[path] = bytes
    }
    if (!snapshot['SKILL.md']) throw new TypeError('A skill must contain SKILL.md')
    for (const path of Object.keys(snapshot)) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) {
        if (parts.slice(0, i).join('/') in snapshot) throw new TypeError(`Skill file is also a directory: ${path}`)
      }
    }
    // The SDK owns frontmatter and manifest validation, including the name/path contract.
    const { parseDocument } = await import('yaml')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot['SKILL.md']).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
    if (!match) throw new TypeError('SKILL.md must start with YAML frontmatter')
    const document = parseDocument(match[1], { uniqueKeys: true })
    if (document.errors.length) throw new TypeError(document.errors[0].message)
    const frontmatter: unknown = document.toJS({ maxAliasCount: 0 })
    if (!frontmatter || typeof frontmatter !== 'object' || !('name' in frontmatter) || typeof frontmatter.name !== 'string') {
      throw new TypeError('SKILL.md must have a name')
    }
    const entry = await skillEntry(frontmatter.name, snapshot)
    return new Skill(snapshot, entry)
  }

  /** Read a directory once, rejecting links and special files before reading content. */
  static async fromDirectory(directory: string): Promise<Skill> {
    const { constants } = await import('node:fs')
    const { lstat, open, readdir } = await import('node:fs/promises')
    const { basename, join, resolve } = await import('node:path')
    const root = resolve(directory)
    const paths: string[] = []
    let total = 0
    async function walk(path: string, relative: string): Promise<void> {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new TypeError(`Skill path is a symlink: ${path}`)
      if (stat.isDirectory()) {
        for (const name of (await readdir(path)).sort()) await walk(join(path, name), relative ? `${relative}/${name}` : name)
      } else if (stat.isFile()) {
        relativeSkillPath(relative)
        paths.push(relative)
        total += stat.size
        checkSkillLimits(paths.length, total)
      } else throw new TypeError(`Skill path is not a regular file: ${path}`)
    }
    if (!(await lstat(root)).isDirectory()) throw new TypeError(`Skill root is not a directory: ${root}`)
    await walk(root, '')
    const files: Record<string, Uint8Array> = Object.create(null)
    for (const path of paths) {
      const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { files[path] = await file.readFile() } finally { await file.close() }
    }
    const skill = await Skill.fromFiles(files)
    if (skill.name !== basename(root)) throw new TypeError(`Skill directory must be named ${skill.name}`)
    return skill
  }

  get name(): string { return this.#entry.frontmatter.name }
  get description(): string { return this.#entry.frontmatter.description }
  get frontmatter(): SkillFrontmatter { return structuredClone(this.#entry.frontmatter) }
  get files(): Readonly<Record<string, Uint8Array>> {
    return Object.fromEntries(Object.entries(this.#files).map(([path, bytes]) => [path, bytes.slice()]))
  }

  toMCPSkill(path = this.name): MCPSkill {
    relativeSkillPath(path)
    if (path.split('/').at(-1) !== this.name) throw new TypeError(`Skill path must end with ${this.name}`)
    const prefix = `skill://${path.split('/').map(encodeURIComponent).join('/')}/`
    if (this.#entry.resources === 'dynamic') throw new Error('A Skill snapshot must have a static manifest')
    const originalPrefix = this.#entry.uri.slice(0, -'SKILL.md'.length)
    const records = new Map(this.#entry.resources.map((file) => [file.uri.slice(originalPrefix.length).split('/').map(decodeURIComponent).join('/'), file]))
    return {
      ...structuredClone(this.#entry),
      uri: `${prefix}SKILL.md`,
      resources: Object.entries(this.#files).map(([file, bytes]) => ({
        uri: prefix + file.split('/').map(encodeURIComponent).join('/'),
        digest: records.get(file)!.digest,
        size: bytes.byteLength,
      })),
    }
  }

  /** Stage and install this snapshot into a directory named after the skill. */
  async toDirectory(directory: string, options: { overwrite?: boolean } = {}): Promise<string> {
    const { lstat, mkdir, mkdtemp, open, rename, rm } = await import('node:fs/promises')
    const { basename, dirname, join, resolve } = await import('node:path')
    const root = resolve(directory)
    if (basename(root) !== this.name) throw new TypeError(`Skill directory must be named ${this.name}`)
    const existing = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new TypeError(`Invalid skill directory: ${root}`)
    if (existing && !options.overwrite) throw new Error(`Skill directory already exists: ${root}`)
    await mkdir(dirname(root), { recursive: true })
    const staging = await mkdtemp(join(dirname(root), `.${this.name}-`))
    const previous = join(staging, 'previous')
    let retained = false
    try {
      const replacement = join(staging, 'new')
      for (const [path, bytes] of Object.entries(this.#files)) {
        const target = join(replacement, path)
        await mkdir(dirname(target), { recursive: true })
        const file = await open(target, 'wx')
        try { await file.writeFile(bytes) } finally { await file.close() }
      }
      if (existing) { await rename(root, previous); retained = true }
      try { await rename(replacement, root) } catch (error) {
        if (retained) {
          try { await rename(previous, root); retained = false } catch (restoreError) {
            throw new Error(`Could not restore ${root}; previous skill remains at ${previous}`, { cause: restoreError })
          }
        }
        throw error
      }
      retained = false
      return root
    } finally {
      if (!retained) await rm(staging, { recursive: true, force: true })
    }
  }
}
