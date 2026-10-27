import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { SkillsExtension, memorySkillFiles } from '@modelcontextprotocol/server/ext/skills'
import { afterEach, describe, expect, it } from 'vitest'
import { Client, SKILLS_EXTENSION_ID } from 'fastmcp-ts/client'
import type { ClientOptions } from 'fastmcp-ts/client'

const SKILLS_OPT_IN = { extensions: { [SKILLS_EXTENSION_ID]: {} } }

const SKILL_URI = 'skill://code-review/SKILL.md'
const SKILL_MD = '---\nname: code-review\ndescription: Review a pull request.\n---\n\n# Code review\n'
const SCRIPT_BYTES = Uint8Array.from([0, 1, 2, 255])

const catalog = await SkillsExtension.load(
  memorySkillFiles({
    'code-review/SKILL.md': SKILL_MD,
    'code-review/scripts/check.py': SCRIPT_BYTES,
    'release-notes/SKILL.md': '---\nname: release-notes\ndescription: Write release notes.\n---\n',
  }),
  { pageSize: 1 },
)

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function connectModern(
  skills: SkillsExtension | undefined,
  options?: ClientOptions,
): Promise<Client> {
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: 'skills', version: '1.0.0' })
      skills?.attach(mcp)
      return mcp
    },
    { legacy: 'reject' },
  )
  const nodeHandler = toNodeHandler(handler)
  const httpServer = createServer((req, res) => {
    void nodeHandler(req, res)
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = (httpServer.address() as AddressInfo).port
  cleanups.push(async () => {
    await handler.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })

  const client = await Client.connect(`http://127.0.0.1:${port}/mcp`, {
    capabilities: SKILLS_OPT_IN,
    versionNegotiation: { mode: { pin: '2026-07-28' } },
    ...options,
  })
  cleanups.push(() => client.close())
  return client
}

describe('Client skills', () => {
  it('lists every skill across pages', async () => {
    const client = await connectModern(catalog)

    expect(client.supportsSkills()).toBe(true)
    expect((await client.listSkills()).map((skill) => skill.uri)).toEqual([
      SKILL_URI,
      'skill://release-notes/SKILL.md',
    ])
  })

  it('gets one skill entry by its SKILL.md URI', async () => {
    const client = await connectModern(catalog)

    const skill = await client.getSkill(SKILL_URI)

    expect(skill.frontmatter).toEqual({ name: 'code-review', description: 'Review a pull request.' })
  })

  it('reads every file of a skill, verified against its entry', async () => {
    const client = await connectModern(catalog)

    const { skill, files } = await client.readSkill(SKILL_URI)

    expect(skill.uri).toBe(SKILL_URI)
    expect(files.map((file) => [file.uri, file.verified])).toEqual([
      [SKILL_URI, true],
      ['skill://code-review/scripts/check.py', true],
    ])
    expect(files[0].body).toBe('\n# Code review\n')
    expect(files[1].bytes).toEqual(SCRIPT_BYTES)
  })

  it('rejects a dynamic skill, which has no file list to read', async () => {
    const live = {
      uri: 'skill://live/SKILL.md',
      frontmatter: { name: 'live', description: 'Generated per request.' },
      resources: 'dynamic' as const,
    }
    const dynamic = new SkillsExtension({
      source: {
        list: async () => ({ skills: [live] }),
        get: async () => live,
        read: async () => undefined,
      },
    })
    const client = await connectModern(dynamic)

    await expect(client.readSkill(live.uri)).rejects.toThrow('no static file list')
  })

  it('requires the client to opt into the extension', async () => {
    const client = await connectModern(catalog, { capabilities: {} })

    expect(client.supportsSkills()).toBe(false)
    await expect(client.listSkills()).rejects.toThrow('did not opt into the Skills extension')
  })

  it('requires the server to advertise the extension', async () => {
    const client = await connectModern(undefined)

    expect(client.supportsSkills()).toBe(false)
    await expect(client.getSkill(SKILL_URI)).rejects.toThrow('does not advertise the Skills extension')
  })

  it('requires a modern connection', async () => {
    const mcp = new McpServer({ name: 'skills', version: '1.0.0' })
    catalog.attach(mcp)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverTransport)
    const client = await Client.connect(clientTransport, {
      capabilities: SKILLS_OPT_IN,
      versionNegotiation: { mode: 'legacy' },
    })
    cleanups.push(async () => {
      await client.close()
      await mcp.close()
    })

    expect(client.supportsSkills()).toBe(false)
    await expect(client.listSkills()).rejects.toThrow('requires a modern (2026-07-28) connection')
  })
})
