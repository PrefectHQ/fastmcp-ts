import { afterEach, describe, expect, it } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FastMCP, Skill, createProxy } from 'fastmcp-ts/server'
import { Client, SKILLS_EXTENSION_ID } from 'fastmcp-ts/client'

const python = process.env.FASTMCP_PYTHON
const fixture = fileURLToPath(new URL('./skills_python.py', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
const optIn = { capabilities: { extensions: { [SKILLS_EXTENSION_ID]: {} } } }
const files = {
  'SKILL.md': '\uFEFF---\r\nname: review\r\ndescription: Review code.\r\n---\r\n\r\nRead guide one.md.\r\n',
  'guide one.md': 'Use tests.\r\n',
  'data.bin': new Uint8Array([0, 255, 13, 10]),
}
const encoded = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value).toString('base64')]))
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function pythonServer(mode: 'serve' | 'proxy', backend?: string): Promise<string> {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  if (!address || typeof address === 'string') throw new Error('No temporary port')
  const port = address.port
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  const child = spawn(python!, [fixture, mode, String(port), ...(backend ? [backend] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(async () => {
    if (child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await exited
  })
  await new Promise<void>((resolve, reject) => {
    let logs = ''
    const timeout = setTimeout(() => reject(new Error(`Python server did not start: ${logs}`)), 15_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Python exited ${code}: ${logs}`)) })
    child.stderr.on('data', (chunk: Buffer) => {
      logs += chunk.toString()
      if (logs.includes('Uvicorn running on')) { clearTimeout(timeout); resolve() }
    })
  })
  return `http://127.0.0.1:${port}/mcp`
}

async function serve(mcp: FastMCP): Promise<string> {
  await mcp.run({ transport: 'http', port: 0 })
  cleanups.push(() => mcp.close())
  return `http://127.0.0.1:${mcp.address!.port}/mcp`
}
async function connect(url: string) {
  const client = await Client.connect(url, optIn)
  cleanups.push(() => client.close())
  return client
}
async function pythonReads(url: string, uri: string, extension: boolean) {
  const result = await promisify(execFile)(python!, [fixture, 'read', url, uri, extension ? 'extension' : 'fallback'], { timeout: 20_000 })
  const downloaded: unknown = JSON.parse(result.stdout)
  expect(downloaded).toEqual(encoded)
}

describe.skipIf(!python)('Real Python skills interoperability', () => {
  it('TypeScript discovers all Python pages, verifies bytes, exports and republishes a snapshot', async () => {
    const client = await connect(await pythonServer('serve'))
    expect((await client.listSkills()).map((entry) => entry.frontmatter.name)).toEqual(['checkout', 'review'])
    const skill = await client.readSkillSnapshot('skill://review/SKILL.md')
    expect(Object.fromEntries(Object.entries(skill.files).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]))).toEqual(encoded)
    const destination = await mkdtemp(join(tmpdir(), 'python-skill-export-'))
    cleanups.push(() => rm(destination, { recursive: true, force: true }))
    const folder = await client.downloadSkill('skill://review/SKILL.md', destination)
    expect((await Skill.fromDirectory(folder)).files).toEqual(skill.files)
    const url = await serve(new FastMCP({ name: 'Republished' }).skills([skill]))
    await pythonReads(url, 'skill://review/SKILL.md', true)
  }, 30_000)
  it('Python verifies TypeScript snapshots through the extension and manifest fallback', async () => {
    const child = new FastMCP({ name: 'Child' }).skills([await Skill.fromFiles(files)])
    const url = await serve(new FastMCP({ name: 'TS' }).mount(child, 'team'))
    await pythonReads(url, 'skill://team/review/SKILL.md', true)
    await pythonReads(url, 'skill://team/review/SKILL.md', false)
  }, 30_000)
  it('a TypeScript gateway preserves Python skill files through nested namespaces', async () => {
    const backend = await createProxy({ type: 'http', url: await pythonServer('serve'), skills: true })
    const url = await serve(new FastMCP({ name: 'Gateway' }).mount(backend, 'backend'))
    const client = await connect(url)
    expect((await client.listSkills()).map((entry) => entry.uri)).toContain('skill://backend/review/SKILL.md')
    await pythonReads(url, 'skill://backend/review/SKILL.md', true)
    await pythonReads(url, 'skill://backend/review/SKILL.md', false)
  }, 30_000)
  it('a Python gateway forwards TypeScript skill discovery and byte-exact files', async () => {
    const backend = await serve(new FastMCP({ name: 'TS Backend' }).skills([await Skill.fromFiles(files)]))
    const client = await connect(await pythonServer('proxy', backend))
    const entry = (await client.listSkills())[0]
    expect(entry.uri).toBe('skill://upstream/review/SKILL.md')
    expect(Object.fromEntries(Object.entries((await client.readSkillSnapshot(entry.uri)).files).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]))).toEqual(encoded)
  }, 30_000)
})
