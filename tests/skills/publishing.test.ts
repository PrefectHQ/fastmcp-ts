import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { FastMCP, Skill, CachingMiddleware, AuthorizationError, FilterTransform } from 'fastmcp-ts/server'
import { ERA_COMBOS, connectEra, describeEachEra } from '../helpers/eras'

const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })
async function temp() { const path = await mkdtemp(join(tmpdir(), 'fastmcp-skills-')); temporary.push(path); return path }
const main = '\uFEFF---\r\nname: review\r\ndescription: Review code.\r\n---\r\n\r\nRead guide.md.\r\n'
async function review() { return Skill.fromFiles({ 'SKILL.md': main, 'guide.md': 'Use tests.\r\n', 'a b.txt': 'space', 'a!b.txt': 'punctuation', '_manifest': 'real file', '100%.txt': 'percent', 'é.txt': 'unicode', 'data.bin': new Uint8Array([0, 255, 13, 10]) }) }

describe('Skill snapshots', () => {
  it('copies input and output bytes and preserves exact file contents', async () => {
    const original = new Uint8Array([1, 2])
    const skill = await Skill.fromFiles({ 'SKILL.md': main, 'data.bin': original })
    original[0] = 3
    skill.files['data.bin'][0] = 4
    expect(skill.files['data.bin']).toEqual(new Uint8Array([1, 2]))
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(skill.files['SKILL.md'])).toBe(main)
  })
  it('authors frontmatter and validates paths and names', async () => {
    const skill = await Skill.create({ name: 'review', description: 'Review code.', instructions: 'Read the diff.', files: { 'guide.md': 'Guide' } })
    expect(skill.name).toBe('review')
    expect(skill.toMCPSkill('team/review').uri).toBe('skill://team/review/SKILL.md')
    await expect(Skill.fromFiles({ 'SKILL.md': main, '../escape': 'no' })).rejects.toThrow('relative POSIX')
    await expect(Skill.fromFiles({ 'SKILL.md': main, x: 'file', 'x/y': 'child' })).rejects.toThrow('also a directory')
    await expect(Skill.fromFiles({ 'SKILL.md': '---\nname: BAD\ndescription: bad\n---\n' })).rejects.toThrow()
  })
  it('round-trips a directory and replaces stale files only with overwrite', async () => {
    const root = join(await temp(), 'review')
    const skill = await review()
    await skill.toDirectory(root)
    await writeFile(join(root, 'stale.txt'), 'stale')
    await expect(skill.toDirectory(root)).rejects.toThrow('already exists')
    await skill.toDirectory(root, { overwrite: true })
    expect((await Skill.fromDirectory(root)).files).toEqual(skill.files)
    await expect(readFile(join(root, 'stale.txt'))).rejects.toThrow()
  })
  it('rejects a symlink anywhere in a skill tree', async () => {
    const parent = await temp()
    const root = join(parent, 'review')
    await mkdir(root)
    await writeFile(join(root, 'SKILL.md'), main)
    await symlink(join(root, 'SKILL.md'), join(root, 'linked.md'))
    await expect(Skill.fromDirectory(root)).rejects.toThrow('symlink')
  })
})

describeEachEra('Skills publishing', (combo) => {
  it('serves byte-exact resources and the legacy manifest, with discovery only on modern connections', async () => {
    const skill = await review()
    const mcp = new FastMCP({ name: 'skills', resourcesPageSize: 1 }).skills([skill])
    const { client, close } = await connectEra(mcp, combo, { capabilities: { extensions: { 'io.modelcontextprotocol/skills': {} } } })
    try {
      const { contents } = await client.readResource({ uri: 'skill://review/SKILL.md' })
      expect(contents[0]).toMatchObject({ text: main })
      const { contents: binary } = await client.readResource({ uri: 'skill://review/data.bin' })
      expect(binary[0]).toMatchObject({ blob: Buffer.from([0, 255, 13, 10]).toString('base64') })
      const { resources } = await client.listResources()
      expect(resources.map((r) => r.uri)).toContain('skill://review/SKILL.md')
      const manifest = await client.readResource({ uri: 'skill://review/_manifest' })
      expect(manifest.contents[0]).toMatchObject({ blob: Buffer.from('real file').toString('base64') })
      if (combo.era === 'modern') {
        const skills = new SkillsClient(client)
        expect((await skills.list()).skills).toEqual([skill.toMCPSkill()])
        const file = await skills.read(skill.toMCPSkill(), 'skill://review/SKILL.md')
        expect(file.verified).toBe(true)
        expect(file.text).toBe(main)
        for (const uri of ['skill://review/a%20b.txt', 'skill://review/a!b.txt', 'skill://review/_manifest', 'skill://review/100%25.txt', 'skill://review/%C3%A9.txt']) expect((await skills.read(skill.toMCPSkill(), uri)).verified).toBe(true)
      }
    } finally { await close() }
  })
})

describe('Skills access and live loaders', () => {
  const combo = ERA_COMBOS.find((combo) => combo.name === 'http-modern')!
  it('loads once per request and refreshes file bytes through response caching', async () => {
    let version = 'old'
    let loads = 0
    const mcp = new FastMCP({ name: 'skills', middleware: [new CachingMiddleware(60_000)] })
    mcp.skills(async () => { loads++; return [await Skill.fromFiles({ 'SKILL.md': main, 'guide.md': version })] })
    const { client, close } = await connectEra(mcp, combo)
    try {
      expect((await client.readResource({ uri: 'skill://review/guide.md' })).contents[0]).toMatchObject({ text: 'old' })
      expect(loads).toBe(1)
      version = 'new'
      expect((await client.readResource({ uri: 'skill://review/guide.md' })).contents[0]).toMatchObject({ text: 'new' })
      expect(loads).toBe(2)
    } finally { await close() }
  })
  it('omits a skill when a supporting file is denied and denies the same read', async () => {
    const mcp = new FastMCP({ name: 'skills', middleware: [{ checkResourceAccess(uri) {
      if (uri.endsWith('guide.md')) throw new AuthorizationError('Denied')
    } }] }).skills([await review()])
    const { client, close } = await connectEra(mcp, combo)
    try {
      expect((await new SkillsClient(client).list()).skills).toEqual([])
      await expect(client.readResource({ uri: 'skill://review/guide.md' })).rejects.toThrow('Denied')
    } finally { await close() }
  })
  it('generates a verifiable resource-mode manifest when no file uses its name', async () => {
    const skill = await Skill.create({ name: 'review', description: 'Review code.', instructions: 'Read the diff.' })
    const mcp = new FastMCP({ name: 'manifest' }).skills([skill])
    const { client, close } = await connectEra(mcp, combo)
    try {
      const result = await client.readResource({ uri: 'skill://review/_manifest' })
      const entry = skill.toMCPSkill()
      if (entry.resources === 'dynamic') throw new Error('Expected static manifest')
      expect(result.contents[0]).toMatchObject({ text: JSON.stringify({ skill: 'review', files: [
        { path: 'SKILL.md', size: skill.files['SKILL.md'].byteLength, hash: entry.resources[0].digest },
      ] }) })
    } finally { await close() }
  })
  it('omits shadowed and transformed skills', async () => {
    const mcp = new FastMCP({ name: 'skills' }).skills([await review()])
    mcp.resource({ uri: 'skill://review/guide.md' }, () => 'override')
    const { client, close } = await connectEra(mcp, combo)
    try { expect((await new SkillsClient(client).list()).skills).toEqual([]) } finally { await close() }
    const filtered = new FastMCP({ name: 'filtered', transforms: [new FilterTransform({ resources: (r) => !r.uri.endsWith('guide.md') })] }).skills([await review()])
    const connection = await connectEra(filtered, combo)
    try { expect((await new SkillsClient(connection.client).list()).skills).toEqual([]) } finally { await connection.close() }
  })
})
