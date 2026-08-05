import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createOpenAPIServer } from 'fastmcp-ts/server'
import type { OpenAPIComponent, OpenAPIServerOptions, RouteMap } from 'fastmcp-ts/server'
import { createTestClient } from '../../helpers/createTestClient'

const FIXTURES = fileURLToPath(new URL('../../fixtures/openapi', import.meta.url))

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
}

interface SnapshotTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown> | null
  tags: string[]
}
interface SnapshotResource {
  uri: string
  name: string
  description: string
  mimeType: string
  tags: string[]
}
interface SnapshotTemplate {
  uriTemplate: string
  name: string
  description: string
  mimeType: string
  parameters: Record<string, unknown>
  tags: string[]
}
interface Snapshot {
  tools: SnapshotTool[]
  resources: SnapshotResource[]
  resourceTemplates: SnapshotTemplate[]
}

function readSnapshot(name: string): Snapshot {
  return readJson(name) as unknown as Snapshot
}

/** Build the server capturing every generated component via componentFn. */
function captureComponents(options: OpenAPIServerOptions): {
  tools: OpenAPIComponent[]
  resources: OpenAPIComponent[]
  resourceTemplates: OpenAPIComponent[]
} {
  const captured = { tools: [], resources: [], resourceTemplates: [] } as {
    tools: OpenAPIComponent[]
    resources: OpenAPIComponent[]
    resourceTemplates: OpenAPIComponent[]
  }
  createOpenAPIServer({
    ...options,
    componentFn: (route, component) => {
      options.componentFn?.(route, component)
      if (component.kind === 'tool') captured.tools.push(component)
      else if (component.kind === 'resource') captured.resources.push(component)
      else captured.resourceTemplates.push(component)
    },
  })
  return captured
}

/** The route maps mirroring the Python snapshot's "components" config. */
const COMPONENT_ROUTE_MAPS: RouteMap[] = [
  { methods: ['GET'], pattern: '^/search$', mcpType: 'exclude' },
  { methods: ['GET'], pattern: '.*\\{.*', mcpType: 'resourceTemplate', mcpTags: ['templated'] },
  { methods: ['GET'], mcpType: 'resource' },
]

describe('createOpenAPIServer parity with Python FastMCP', () => {
  it('matches the petstore default snapshot: every tool, byte for byte', () => {
    const snapshot = readSnapshot('petstore-3.1.default.snapshot.json')
    const captured = captureComponents({ spec: readJson('petstore-3.1.json') })

    expect(captured.resources).toHaveLength(0)
    expect(captured.resourceTemplates).toHaveLength(0)
    expect(
      captured.tools.map((t) => (t.kind === 'tool' ? t.name : '')),
    ).toEqual(snapshot.tools.map((t) => t.name))

    for (const [i, expected] of snapshot.tools.entries()) {
      const actual = captured.tools[i]
      if (actual.kind !== 'tool') throw new Error('expected tool')
      expect(actual.description, expected.name).toBe(expected.description)
      expect(actual.tags, expected.name).toEqual(expected.tags)
      expect(actual.inputSchema, expected.name).toEqual(expected.inputSchema)
      expect(actual.outputSchema ?? null, expected.name).toEqual(expected.outputSchema)
    }
  })

  it('matches the petstore components snapshot: resources and templates', () => {
    const snapshot = readSnapshot('petstore-3.1.components.snapshot.json')
    const captured = captureComponents({
      spec: readJson('petstore-3.1.json'),
      routeMaps: COMPONENT_ROUTE_MAPS,
      tags: ['api'],
    })

    expect(
      captured.tools.map((t) => (t.kind === 'tool' ? t.name : '')),
    ).toEqual(snapshot.tools.map((t) => t.name))

    expect(captured.resources).toHaveLength(snapshot.resources.length)
    for (const [i, expected] of snapshot.resources.entries()) {
      const actual = captured.resources[i]
      if (actual.kind !== 'resource') throw new Error('expected resource')
      expect(actual.uri, expected.uri).toBe(expected.uri)
      expect(actual.name, expected.uri).toBe(expected.name)
      expect(actual.description, expected.uri).toBe(expected.description)
      expect(actual.mimeType, expected.uri).toBe(expected.mimeType)
      expect(actual.tags, expected.uri).toEqual(expected.tags)
    }

    expect(captured.resourceTemplates).toHaveLength(snapshot.resourceTemplates.length)
    for (const [i, expected] of snapshot.resourceTemplates.entries()) {
      const actual = captured.resourceTemplates[i]
      if (actual.kind !== 'resourceTemplate') throw new Error('expected template')
      expect(actual.uriTemplate, expected.uriTemplate).toBe(expected.uriTemplate)
      expect(actual.name, expected.uriTemplate).toBe(expected.name)
      expect(actual.description, expected.uriTemplate).toBe(expected.description)
      expect(actual.mimeType, expected.uriTemplate).toBe(expected.mimeType)
      expect(actual.parameters, expected.uriTemplate).toEqual(expected.parameters)
      expect(actual.tags, expected.uriTemplate).toEqual(expected.tags)
    }
  })

  it('matches the permissive snapshot: renamed tool, permissive output schemas', () => {
    const snapshot = readSnapshot('petstore-3.1.permissive.snapshot.json')
    const captured = captureComponents({
      spec: readJson('petstore-3.1.json'),
      validateOutput: false,
      names: { listPets: 'pets_index' },
    })

    for (const [i, expected] of snapshot.tools.entries()) {
      const actual = captured.tools[i]
      if (actual.kind !== 'tool') throw new Error('expected tool')
      expect(actual.name, expected.name).toBe(expected.name)
      expect(actual.outputSchema ?? null, expected.name).toEqual(expected.outputSchema)
    }
  })

  it('matches the 3.0 edge-cases snapshot', () => {
    const snapshot = readSnapshot('edge-cases-3.0.default.snapshot.json')
    const captured = captureComponents({ spec: readJson('edge-cases-3.0.json') })

    for (const [i, expected] of snapshot.tools.entries()) {
      const actual = captured.tools[i]
      if (actual.kind !== 'tool') throw new Error('expected tool')
      expect(actual.name, expected.name).toBe(expected.name)
      expect(actual.inputSchema, expected.name).toEqual(expected.inputSchema)
      expect(actual.outputSchema ?? null, expected.name).toEqual(expected.outputSchema)
    }
  })

  it('advertises the generated schemas verbatim over the MCP wire', async () => {
    const snapshot = readSnapshot('petstore-3.1.default.snapshot.json')
    const server = createOpenAPIServer({ spec: readJson('petstore-3.1.json') })
    const { client, close } = await createTestClient(server)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(snapshot.tools.map((t) => t.name).sort())
      for (const expected of snapshot.tools) {
        const advertised = tools.find((t) => t.name === expected.name)
        expect(advertised, expected.name).toBeDefined()
        expect(advertised?.description, expected.name).toBe(expected.description)
        expect(advertised?.inputSchema, expected.name).toEqual(expected.inputSchema)
        expect(advertised?.outputSchema ?? null, expected.name).toEqual(expected.outputSchema)
      }
    } finally {
      await close()
    }
  })

  it('advertises resources and templates over the MCP wire', async () => {
    const snapshot = readSnapshot('petstore-3.1.components.snapshot.json')
    const server = createOpenAPIServer({
      spec: readJson('petstore-3.1.json'),
      routeMaps: COMPONENT_ROUTE_MAPS,
      tags: ['api'],
    })
    const { client, close } = await createTestClient(server)
    try {
      const { resources } = await client.listResources()
      expect(resources.map((r) => r.uri).sort()).toEqual(
        snapshot.resources.map((r) => r.uri).sort(),
      )
      const { resourceTemplates } = await client.listResourceTemplates()
      expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(
        snapshot.resourceTemplates.map((t) => t.uriTemplate).sort(),
      )
      const petTemplate = resourceTemplates.find(
        (t) => t.uriTemplate === 'resource://getPetById/{petId}',
      )
      expect(petTemplate?.mimeType).toBe('application/json')
    } finally {
      await close()
    }
  })
})

describe('createOpenAPIServer options', () => {
  const spec = () => readJson('petstore-3.1.json')

  it('defaults the server name to OpenAPI Server (Python parity)', async () => {
    const { client, close } = await createTestClient(createOpenAPIServer({ spec: spec() }))
    try {
      expect(client.getServerVersion()?.name).toBe('OpenAPI Server')
    } finally {
      await close()
    }
  })

  it('applies explicit name and version', async () => {
    const server = createOpenAPIServer({ spec: spec(), name: 'Petstore', version: '9.9.9' })
    const { client, close } = await createTestClient(server)
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'Petstore', version: '9.9.9' })
    } finally {
      await close()
    }
  })

  it('accepts the spec as YAML text', () => {
    const yaml = [
      'openapi: 3.1.0',
      'info: {title: Y, version: "1"}',
      'servers: [{url: "https://y.example.com"}]',
      'paths:',
      '  /a:',
      '    get:',
      '      operationId: getA',
      '      responses:',
      '        "200": {description: ok}',
    ].join('\n')
    const captured = captureComponents({ spec: yaml })
    expect(captured.tools.map((t) => (t.kind === 'tool' ? t.name : ''))).toEqual(['getA'])
  })

  it('throws when the spec has no server URL and no baseUrl is given', () => {
    const bare = spec()
    delete bare.servers
    expect(() => createOpenAPIServer({ spec: bare })).toThrow('No server URL found')
    // An explicit baseUrl fixes it.
    expect(() =>
      createOpenAPIServer({ spec: bare, client: { baseUrl: 'https://api.example.com' } }),
    ).not.toThrow()
  })

  it('throws when the servers URL is relative and no baseUrl is given', () => {
    const relative = spec()
    relative.servers = [{ url: '/api/v1' }]
    expect(() => createOpenAPIServer({ spec: relative })).toThrow('must be absolute')
  })

  it('fills server URL variables with their defaults', () => {
    const withVars = spec()
    withVars.servers = [
      {
        url: 'https://{region}.example.com/{basePath}',
        variables: { region: { default: 'eu' }, basePath: { default: 'v2' } },
      },
    ]
    // Resolution happens eagerly; reaching tool generation proves it parsed.
    expect(() => createOpenAPIServer({ spec: withVars })).not.toThrow()
  })

  it('lets routeMapFn override the mapped type and swallows its exceptions', () => {
    const captured = captureComponents({
      spec: spec(),
      routeMapFn: (route, mcpType) => {
        if (route.path === '/search') throw new Error('boom')
        if (route.method === 'GET' && route.path === '/pets') return 'exclude'
        return mcpType
      },
    })
    const names = captured.tools.map((t) => (t.kind === 'tool' ? t.name : ''))
    expect(names).not.toContain('listPets')
    expect(names).toContain('GET_search')
  })

  it('applies componentFn mutations before registration and swallows exceptions', async () => {
    const server = createOpenAPIServer({
      spec: spec(),
      componentFn: (_route, component) => {
        if (component.kind === 'tool' && component.name === 'listPets') {
          component.name = 'renamed_pets'
          component.description = 'Renamed.'
        }
        if (component.kind === 'tool' && component.name === 'createPet') {
          throw new Error('boom')
        }
      },
    })
    const { client, close } = await createTestClient(server)
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain('renamed_pets')
      expect(names).not.toContain('listPets')
      expect(names).toContain('createPet')
      expect(tools.find((t) => t.name === 'renamed_pets')?.description).toBe('Renamed.')
    } finally {
      await close()
    }
  })
})
