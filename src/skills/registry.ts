import type { Skill as MCPSkill } from '@modelcontextprotocol/core/ext/skills'
import type { McpContext } from '../server/context'
import type { AuthCheck } from '../server/auth/authorization'
import { Skill, relativeSkillPath } from './skill'
import { AuthorizationError } from '../server/auth/types'
import { ResourceResult } from '../server/resource'
import { ResourceNotFoundError } from '@modelcontextprotocol/server'

export type SkillCatalog = readonly Skill[] | Readonly<Record<string, Skill>>
export type SkillLoader = () => SkillCatalog | Promise<SkillCatalog>

export interface PublishedSkill {
  entry: MCPSkill
  owner?: object
  read(uri: string): Promise<Uint8Array>
  auth?: AuthCheck
  discoverable?: boolean
  checkAccess?(uri: string): Promise<void>
}

export type SkillSource = (context: McpContext, uri?: string) => Promise<PublishedSkill[]>

export class SkillRegistry {
  private readonly sources: SkillSource[] = []
  private readonly requests = new WeakMap<McpContext, Map<string, Promise<PublishedSkill[]>>>()

  constructor(private readonly onSourceError?: (error: unknown) => void) {}

  get enabled(): boolean { return this.sources.length > 0 }

  add(source: SkillSource): void { this.sources.push(source) }

  publish(catalog: SkillCatalog | SkillLoader, auth?: AuthCheck): void {
    this.add(async () => {
      const loaded = typeof catalog === 'function' ? await catalog() : catalog
      const items: Array<[string, Skill]> = Array.isArray(loaded)
        ? loaded.map((skill: Skill) => [skill.name, skill])
        : Object.entries(loaded)
      const allPaths = new Set(items.map(([path]) => path))
      for (const path of allPaths) {
        const parts = path.split('/')
        for (let i = 1; i < parts.length; i++) {
          if (allPaths.has(parts.slice(0, i).join('/'))) throw new TypeError(`Skill path is nested inside another skill: ${path}`)
        }
      }
      const paths = new Set<string>()
      return items.map(([path, skill]) => {
        relativeSkillPath(path)
        if (!(skill instanceof Skill)) throw new TypeError(`Expected a Skill at ${path}`)
        if (paths.has(path)) throw new TypeError(`Duplicate skill path: ${path}`)
        paths.add(path)
        const entry = skill.toMCPSkill(path)
        const prefix = entry.uri.slice(0, -'SKILL.md'.length)
        const files = skill.files
        return {
          entry, auth,
          async read(uri) {
            const relative = uri.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
            const bytes = files[relative]
            if (!bytes) throw new Error(`Unknown skill file: ${uri}`)
            return bytes.slice()
          },
        }
      })
    })
  }

  load(ctx: McpContext, uri?: string): Promise<PublishedSkill[]> {
    let requests = this.requests.get(ctx)
    if (!requests) { requests = new Map(); this.requests.set(ctx, requests) }
    const key = uri ?? ''
    let request = requests.get(key)
    if (!request) {
      request = Promise.all(this.sources.map(async (source) => {
        try { return await source(ctx, uri) } catch (error) {
          if (!this.onSourceError) throw error
          this.onSourceError(error)
          return []
        }
      })).then((groups) => groups.flat())
      requests.set(key, request)
    }
    return request
  }

  async visible(ctx: McpContext, mayRead: (source: PublishedSkill, uri: string) => Promise<boolean>, uri?: string): Promise<MCPSkill[]> {
    const sources = await this.load(ctx, uri)
    const counts = new Map<string, number>()
    for (const { entry } of sources) counts.set(entry.uri, (counts.get(entry.uri) ?? 0) + 1)
    const entries: MCPSkill[] = []
    for (const source of sources) {
      if (source.discoverable === false || counts.get(source.entry.uri) !== 1 || source.entry.resources === 'dynamic') continue
      let visible = true
      for (const file of source.entry.resources) {
        const owners = sources.filter(({ entry }) => entry.resources !== 'dynamic' && entry.resources.some((record) => record.uri === file.uri))
        if (owners.length !== 1 || !await mayRead(source, file.uri)) { visible = false; break }
      }
      if (visible) entries.push(source.entry)
    }
    return entries.sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0)
  }

  async authorize(source: PublishedSkill, ctx: McpContext, uri: string): Promise<void> {
    await source.checkAccess?.(uri)
    if (!source.auth) return
    if (!ctx.auth) throw new AuthorizationError('Authentication required')
    await source.auth(ctx.auth)
  }

  async read(uri: string, ctx: McpContext): Promise<ResourceResult> {
    const matches = (await this.load(ctx)).filter(({ entry }) => {
      const prefix = entry.uri.slice(0, -'SKILL.md'.length)
      return uri === `${prefix}_manifest` || (entry.resources !== 'dynamic' && entry.resources.some((file) => file.uri === uri))
    })
    if (matches.length !== 1) throw new ResourceNotFoundError(uri)
    const source = matches[0]
    await this.authorize(source, ctx, uri)
    if (uri.endsWith('/_manifest') && source.entry.resources !== 'dynamic' && !source.entry.resources.some((file) => file.uri === uri)) {
      const prefix = source.entry.uri.slice(0, -'SKILL.md'.length)
      return new ResourceResult([{ uri, mimeType: 'application/json', text: JSON.stringify({ skill: source.entry.frontmatter.name,
        files: source.entry.resources.map((file) => ({ path: file.uri.slice(prefix.length).split('/').map(decodeURIComponent).join('/'), size: file.size, hash: file.digest })) }) }])
    }
    const bytes = await source.read(uri)
    if (/\.(md|txt|json|yaml|yml|py|js|ts|sh)$/.test(uri)) {
      try { return new ResourceResult([{ uri, mimeType: uri.endsWith('.md') ? 'text/markdown' : 'text/plain', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }]) } catch (error) {
        if (!(error instanceof TypeError)) throw error
      }
    }
    return new ResourceResult([{ uri, mimeType: 'application/octet-stream', blob: Buffer.from(bytes).toString('base64') }])
  }
}
