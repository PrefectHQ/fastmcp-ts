import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { Server, createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client, SKILLS_EXTENSION_ID } from 'fastmcp-ts/client'
import type { ClientOptions } from 'fastmcp-ts/client'

const SKILLS_OPT_IN = { extensions: { [SKILLS_EXTENSION_ID]: {} } }

const SKILL_URI = 'skill://code-review/SKILL.md'
const SCRIPT_URI = 'skill://code-review/scripts/check.py'
const SKILL_MD = '---\nname: code-review\ndescription: Review a pull request.\n---\n\n# Code review\n'
const SCRIPT_BYTES = Uint8Array.from([0, 1, 2, 255])

type ServedFile = { text: string } | { blob: Uint8Array }

const FILES: Record<string, ServedFile> = {
  [SKILL_URI]: { text: SKILL_MD },
  [SCRIPT_URI]: { blob: SCRIPT_BYTES },
}

function fileBytes(file: ServedFile): Uint8Array {
  return 'text' in file ? new TextEncoder().encode(file.text) : file.blob
}

function skillEntry(name: string, files: Record<string, ServedFile>) {
  return {
    uri: `skill://${name}/SKILL.md`,
    frontmatter: { name, description: `The ${name} skill.` },
    resources: Object.entries(files).map(([uri, file]) => {
      const bytes = fileBytes(file)
      return {
        uri,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.length,
      }
    }),
  }
}

const CODE_REVIEW = skillEntry('code-review', FILES)
const RELEASE_NOTES = skillEntry('release-notes', {
  'skill://release-notes/SKILL.md': { text: 'notes' },
})

/** A raw SDK server: FastMCP-ts serves no skills, so the fixture speaks the extension's wire directly. */
function skillsServer({
  pages = [[CODE_REVIEW], [RELEASE_NOTES]],
  served = FILES,
}: {
  pages?: ReadonlyArray<ReadonlyArray<{ uri: string }>>
  served?: Record<string, ServedFile>
} = {}) {
  const server = new Server(
    { name: 'skills', version: '1.0.0' },
    { capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } } },
  )
  server.setRequestHandler(
    'skills/list',
    { params: z.looseObject({ cursor: z.string().optional() }) },
    async ({ cursor }) => {
      const index = cursor === undefined ? 0 : Number(cursor)
      const next = index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}
      return { skills: pages[index], ...next }
    },
  )
  server.setRequestHandler(
    'skills/get',
    { params: z.looseObject({ uri: z.string() }) },
    async ({ uri }) => ({ skill: pages.flat().find((entry) => entry.uri === uri) }),
  )
  server.setRequestHandler('resources/read', async (request) => {
    const uri = request.params.uri
    const file = served[uri]
    if (!file) throw new Error(`Unknown resource ${uri}`)
    return {
      contents: [
        'text' in file
          ? { uri, text: file.text }
          : { uri, blob: Buffer.from(file.blob).toString('base64') },
      ],
    }
  })
  return server
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function connectModern(server: Server, options?: ClientOptions): Promise<Client> {
  const handler = createMcpHandler(() => server, { legacy: 'reject' })
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
  it('lists skills across every page', async () => {
    const client = await connectModern(skillsServer())

    expect(client.supportsSkills()).toBe(true)
    expect(await client.listSkills()).toEqual([CODE_REVIEW, RELEASE_NOTES])
  })

  it('gets one skill entry by its SKILL.md URI', async () => {
    const client = await connectModern(skillsServer())

    expect(await client.getSkill(SKILL_URI)).toEqual(CODE_REVIEW)
  })

  it('rejects an entry whose files fall outside the skill directory', async () => {
    const stray = {
      ...CODE_REVIEW,
      resources: [...CODE_REVIEW.resources, { ...CODE_REVIEW.resources[1], uri: 'skill://other/x.py' }],
    }
    const client = await connectModern(skillsServer({ pages: [[stray]] }))

    await expect(client.listSkills()).rejects.toThrow('every skill file must be inside the skill directory')
  })

  it('reads every file of a skill keyed by its relative path', async () => {
    const client = await connectModern(skillsServer())

    const skill = await client.readSkill(SKILL_URI)

    expect(skill.entry).toEqual(CODE_REVIEW)
    expect([...skill.files.keys()]).toEqual(['SKILL.md', 'scripts/check.py'])
    expect(new TextDecoder().decode(skill.files.get('SKILL.md'))).toBe(SKILL_MD)
    expect(skill.files.get('scripts/check.py')).toEqual(SCRIPT_BYTES)
  })

  it('rejects a file whose bytes do not match the entry digest', async () => {
    const tampered = { ...FILES, [SCRIPT_URI]: { blob: Uint8Array.from([9, 9, 9, 9]) } }
    const client = await connectModern(skillsServer({ served: tampered }))

    await expect(client.readSkill(SKILL_URI)).rejects.toThrow(
      "scripts/check.py does not match its entry's digest",
    )
  })

  it('rejects a dynamic skill, which has no file list to read', async () => {
    const dynamic = { ...CODE_REVIEW, resources: 'dynamic' }
    const client = await connectModern(skillsServer({ pages: [[dynamic]] }))

    await expect(client.readSkill(SKILL_URI)).rejects.toThrow('no static file list')
  })

  it('requires the client to opt into the extension', async () => {
    const client = await connectModern(skillsServer(), { capabilities: {} })

    expect(client.supportsSkills()).toBe(false)
    await expect(client.listSkills()).rejects.toThrow('did not opt into the Skills extension')
  })

  it('requires the server to advertise the extension', async () => {
    const server = new Server({ name: 'plain', version: '1.0.0' }, { capabilities: { tools: {} } })
    const client = await connectModern(server)

    expect(client.supportsSkills()).toBe(false)
    await expect(client.getSkill(SKILL_URI)).rejects.toThrow('does not advertise the Skills extension')
  })

  it('requires a modern connection', async () => {
    const server = skillsServer()
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = await Client.connect(clientTransport, {
      capabilities: SKILLS_OPT_IN,
      versionNegotiation: { mode: 'legacy' },
    })
    cleanups.push(async () => {
      await client.close()
      await server.close()
    })

    expect(client.supportsSkills()).toBe(false)
    await expect(client.listSkills()).rejects.toThrow('requires a modern (2026-07-28) connection')
  })
})
