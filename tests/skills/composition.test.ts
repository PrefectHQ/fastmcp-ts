import { describe, expect, it } from 'vitest'
import { ListSkillsRequestParamsSchema, GetSkillRequestParamsSchema, SKILLS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/skills'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { FastMCP, Skill, createProxy, AuthorizationError } from 'fastmcp-ts/server'
import { ERA_COMBOS, connectEra } from '../helpers/eras'

const modern = ERA_COMBOS.find((combo) => combo.name === 'http-modern')!
async function review(description = 'Review code.') {
  return Skill.create({ name: 'review', description, instructions: 'Read guide one.md.', files: { 'guide one.md': 'Use tests.\r\n' } })
}

describe('Mounted skills', () => {
  it('rewrites manifest and file URIs through multiple namespaces', async () => {
    const child = new FastMCP({ name: 'child' }).skills([await review()])
    const parent = new FastMCP({ name: 'parent' }).mount(child, 'team')
    const root = new FastMCP({ name: 'root' }).mount(parent, 'org')
    const { client, close } = await connectEra(root, modern)
    try {
      const skills = new SkillsClient(client)
      const { skills: entries } = await skills.list()
      expect(entries.map((entry) => entry.uri)).toEqual(['skill://org/team/review/SKILL.md'])
      expect((await skills.read(entries[0], 'skill://org/team/review/guide%20one.md')).text).toBe('Use tests.\r\n')
      expect((await client.readResource({ uri: 'skill://org/team/review/_manifest' })).contents[0]).toHaveProperty('text')
    } finally { await close() }
  })
  it('includes skills registered after mounting and runs child read policy', async () => {
    const child = new FastMCP({ name: 'child', middleware: [{ checkResourceAccess(uri) {
      if (uri.endsWith('guide%20one.md')) throw new AuthorizationError('No guide')
    } }] })
    const parent = new FastMCP({ name: 'parent' }).mount(child, 'team')
    child.skills([await review()])
    const { client, close } = await connectEra(parent, modern)
    try {
      expect((await new SkillsClient(client).list()).skills).toEqual([])
      await expect(client.readResource({ uri: 'skill://team/review/guide%20one.md' })).rejects.toThrow()
    } finally { await close() }
  })
  it('omits all colliding skill identities instead of selecting a source', async () => {
    const child = new FastMCP({ name: 'child' }).skills([await review('Child')])
    const parent = new FastMCP({ name: 'parent' }).skills([await review('Parent')]).mount(child)
    const { client, close } = await connectEra(parent, modern)
    try {
      expect((await new SkillsClient(client).list()).skills).toEqual([])
      await expect(client.readResource({ uri: 'skill://review/SKILL.md' })).rejects.toThrow()
    } finally { await close() }
  })
  it('keeps healthy sources available, with an explicit fail-fast option', async () => {
    for (const strategy of ['warn', 'raise'] as const) {
      const parent = new FastMCP({ name: 'parent', skillsErrorStrategy: strategy, logLevel: 'silent' })
      parent.skills([await review()]).skills(async () => { throw new Error('Storage unavailable') })
      const { client, close } = await connectEra(parent, modern)
      try {
        const listing = new SkillsClient(client).list()
        if (strategy === 'raise') await expect(listing).rejects.toThrow('Storage unavailable')
        else expect((await listing).skills).toHaveLength(1)
      } finally { await close() }
    }
  })
})

describe('Proxied skills', () => {
  it('forwards modern discovery, live files and namespaces alongside ordinary resources', async () => {
    let description = 'Old'
    const backend = new FastMCP({ name: 'backend' }).skills(async () => [await review(description)])
    backend.resource({ uri: 'memo://note' }, () => 'ordinary resource')
    backend.resource({ uri: 'skill://loose/notes.md' }, () => 'ordinary skill-scheme resource')
    await backend.run({ transport: 'http', port: 0 })
    const proxy = await createProxy({ type: 'http', url: `http://127.0.0.1:${backend.address!.port}/mcp`, skills: true })
    const gateway = new FastMCP({ name: 'gateway' }).mount(proxy, 'backend')
    const { client, close } = await connectEra(gateway, modern)
    try {
      const skills = new SkillsClient(client)
      const first = (await skills.list()).skills[0]
      expect(first.uri).toBe('skill://backend/review/SKILL.md')
      expect((await skills.read(first, 'skill://backend/review/guide%20one.md')).text).toBe('Use tests.\r\n')
      expect((await client.readResource({ uri: 'skill://backend/loose/notes.md' })).contents[0]).toMatchObject({ text: 'ordinary skill-scheme resource' })
      description = 'New'
      expect((await skills.get(first.uri)).skill.frontmatter.description).toBe('New')
      expect((await client.readResource({ uri: 'memo://backend/note' })).contents[0]).toMatchObject({ text: 'ordinary resource' })
    } finally { await close(); await backend.close() }
  })
  it('looks up an unlisted backend skill independently of listing', async () => {
    const backend = new FastMCP({ name: 'partial', middleware: [{ async onRequest(ctx, next) {
      if (ctx.method === 'skills/list') return { skills: [], ttlMs: 0, cacheScope: 'private', resultType: 'complete' }
      return next()
    } }] }).skills([await review()])
    await backend.run({ transport: 'http', port: 0 })
    const proxy = await createProxy({ type: 'http', url: `http://127.0.0.1:${backend.address!.port}/mcp`, skills: true })
    const { client, close } = await connectEra(proxy, modern)
    try {
      const skills = new SkillsClient(client)
      expect((await skills.list()).skills).toEqual([])
      expect((await skills.get('skill://review/SKILL.md')).skill.frontmatter.name).toBe('review')
    } finally { await close(); await backend.close() }
  })
  it('preserves entries and ordinary resource routing under a custom URI scheme', async () => {
    const snapshot = await review()
    const original = snapshot.toMCPSkill()
    if (original.resources === 'dynamic') throw new Error('Expected static skill')
    const entry = { ...original, uri: original.uri.replace('skill:', 'agent:'),
      resources: original.resources.map((file) => ({ ...file, uri: file.uri.replace('skill:', 'agent:') })) }
    const backend = new FastMCP({ name: 'custom', middleware: [{ setup(server) {
      server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } })
      server.setRequestHandler('skills/list', { params: ListSkillsRequestParamsSchema }, () => ({ skills: [entry], ttlMs: 0, cacheScope: 'private' }))
      server.setRequestHandler('skills/get', { params: GetSkillRequestParamsSchema }, () => ({ skill: entry, ttlMs: 0, cacheScope: 'private' }))
    } }] })
    for (const [path, bytes] of Object.entries(snapshot.files)) {
      backend.resource({ uri: `agent://review/${encodeURIComponent(path)}` }, () => new TextDecoder().decode(bytes))
    }
    await backend.run({ transport: 'http', port: 0 })
    const proxy = await createProxy({ type: 'http', url: `http://127.0.0.1:${backend.address!.port}/mcp`, skills: true })
    const gateway = new FastMCP({ name: 'gateway' }).mount(proxy, 'team')
    const { client, close } = await connectEra(gateway, modern)
    try {
      const skills = new SkillsClient(client)
      const advertised = (await skills.list()).skills[0]
      expect(advertised.uri).toBe('agent://team/review/SKILL.md')
      expect((await skills.read(advertised, 'agent://team/review/guide%20one.md')).verified).toBe(true)
      expect((await skills.get(advertised.uri)).skill).toEqual(advertised)
    } finally { await close(); await backend.close() }
  })
  it('leaves a backend without Skills usable when discovery is enabled', async () => {
    const backend = new FastMCP({ name: 'backend' })
    backend.resource({ uri: 'memo://note' }, () => 'plain')
    await backend.run({ transport: 'http', port: 0 })
    const proxy = await createProxy({ type: 'http', url: `http://127.0.0.1:${backend.address!.port}/mcp`, skills: true })
    const { client, close } = await connectEra(proxy, modern)
    try { expect((await client.readResource({ uri: 'memo://note' })).contents[0]).toMatchObject({ text: 'plain' }) }
    finally { await close(); await backend.close() }
  })
})
