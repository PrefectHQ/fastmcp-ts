import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FastMCP, Skill } from 'fastmcp-ts/server'
import { Client, SKILLS_EXTENSION_ID } from 'fastmcp-ts/client'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup() })
const main = '\uFEFF---\r\nname: review\r\ndescription: Review code.\r\n---\r\n\r\nRead the diff.\r\n'
async function connect(mcp: FastMCP, extension: boolean) {
  await mcp.run({ transport: 'http', port: 0 })
  close.push(() => mcp.close())
  const client = await Client.connect(`http://127.0.0.1:${mcp.address!.port}/mcp`, {
    ...(extension ? { capabilities: { extensions: { [SKILLS_EXTENSION_ID]: {} } } } : {}),
  })
  close.push(() => client.close())
  return client
}

for (const extension of [true, false]) describe(`Skill export (${extension ? 'extension' : 'resource fallback'})`, () => {
  it('verifies exact files, exports snapshots and republishes them', async () => {
    const original = await Skill.fromFiles({ 'SKILL.md': main, 'guide one.md': 'Guide\r\n', 'data.bin': new Uint8Array([0, 255]) })
    const client = await connect(new FastMCP({ name: 'skills' }).skills([original]), extension)
    const contents = await client.readSkill('skill://review/SKILL.md')
    expect(contents.files.every((file) => file.verified)).toBe(true)
    expect(contents.files.find((file) => file.uri.endsWith('guide%20one.md'))?.text).toBe('Guide\r\n')
    const snapshot = await client.readSkillSnapshot('skill://review/SKILL.md')
    expect(snapshot.files).toEqual(original.files)
    const destination = await mkdtemp(join(tmpdir(), 'fastmcp-download-'))
    close.push(() => rm(destination, { recursive: true, force: true }))
    expect(await client.downloadSkill('skill://review/SKILL.md', destination)).toBe(join(destination, 'review'))
    expect(await readFile(join(destination, 'review', 'SKILL.md'), 'utf8')).toBe(main)
    await expect(client.syncSkills(destination)).rejects.toThrow('already exists')
    expect(await client.syncSkills(destination, { overwrite: true })).toEqual([join(destination, 'review')])
    const republished = await connect(new FastMCP({ name: 'copy' }).skills([snapshot]), true)
    expect((await republished.readSkillSnapshot('skill://review/SKILL.md')).files).toEqual(original.files)
  })
})

describe('Manifest verification', () => {
  function resourceServer(records: unknown[], body = main) {
    const mcp = new FastMCP({ name: 'resource-mode' })
    mcp.resource({ uri: 'skill://review/_manifest' }, () => JSON.stringify({ skill: 'review', files: records }))
    mcp.resource({ uri: 'skill://review/SKILL.md' }, () => body)
    return mcp
  }
  const valid = { path: 'SKILL.md', size: Buffer.byteLength(main), hash: `sha256:${createHash('sha256').update(main).digest('hex')}` }
  it('rejects corrupt bytes and missing main files', async () => {
    const client = await connect(resourceServer([valid], 'corrupt'), false)
    await expect(client.readSkill('skill://review/SKILL.md')).rejects.toThrow('manifest size')
    const sameSize = await connect(resourceServer([{ ...valid, hash: 'sha256:' + '0'.repeat(64) }]), false)
    await expect(sameSize.readSkill('skill://review/SKILL.md')).rejects.toThrow('manifest digest')
    const missing = await connect(resourceServer([{ ...valid, path: 'guide.md' }]), false)
    await expect(missing.readSkill('skill://review/SKILL.md')).rejects.toThrow('include SKILL.md')
  })
  it('rejects traversal, duplicates, and oversized manifests before fetching files', async () => {
    for (const records of [[valid, { ...valid, path: '../escape' }], [valid, valid], [{ ...valid, size: 16 * 1024 * 1024 + 1 }]]) {
      let reads = 0
      const server = resourceServer(records)
      server.resource({ uri: 'skill://review/SKILL.md' }, () => { reads++; return main })
      const client = await connect(server, false)
      await expect(client.readSkill('skill://review/SKILL.md')).rejects.toThrow()
      expect(reads).toBe(0)
    }
  })
  it('falls back when a negotiated extension does not know a resource-mode skill', async () => {
    const other = await Skill.create({ name: 'other', description: 'Other skill.', instructions: 'Other' })
    const mcp = resourceServer([valid]).skills([other])
    const client = await connect(mcp, true)
    expect((await client.readSkillSnapshot('skill://review/SKILL.md')).name).toBe('review')
  })
})
