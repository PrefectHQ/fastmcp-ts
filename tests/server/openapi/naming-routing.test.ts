import { describe, expect, it } from 'vitest'
import { NameRegistry, generateDefaultName, slugify } from '../../../src/server/openapi/naming'
import { DEFAULT_ROUTE_MAPPINGS, determineRouteType } from '../../../src/server/openapi/routing'
import type { HTTPRoute, RouteMap } from '../../../src/server/openapi/types'

function makeRoute(partial: Partial<HTTPRoute>): HTTPRoute {
  return {
    path: '/x',
    method: 'GET',
    tags: [],
    parameters: [],
    responses: {},
    requestSchemas: {},
    responseSchemas: {},
    extensions: {},
    flatParamSchema: {},
    parameterMap: {},
    ...partial,
  }
}

describe('slugify', () => {
  it('replaces separators with underscores and strips other characters', () => {
    expect(slugify('Get pet photos!')).toBe('Get_pet_photos')
    expect(slugify('duplicate-name')).toBe('duplicate_name')
    expect(slugify('a.b c-d')).toBe('a_b_c_d')
    expect(slugify('GET_/search')).toBe('GET_search')
    expect(slugify('__weird__')).toBe('weird')
    expect(slugify('')).toBe('')
  })
})

describe('generateDefaultName', () => {
  it('uses the operationId before any double-underscore suffix', () => {
    expect(generateDefaultName(makeRoute({ operationId: 'getPetById__internal' }))).toBe(
      'getPetById',
    )
  })

  it('prefers the names map over the operationId', () => {
    expect(
      generateDefaultName(makeRoute({ operationId: 'listPets' }), { listPets: 'pets_index' }),
    ).toBe('pets_index')
  })

  it('falls back to summary, then METHOD_path', () => {
    expect(generateDefaultName(makeRoute({ summary: 'Get pet photos!' }))).toBe('Get_pet_photos')
    expect(generateDefaultName(makeRoute({ method: 'GET', path: '/search' }))).toBe('GET_search')
  })

  it('truncates to 56 characters', () => {
    const name = generateDefaultName(
      makeRoute({
        operationId: 'generatePetInventoryAuditReportForVeterinaryComplianceReview',
      }),
    )
    expect(name).toBe('generatePetInventoryAuditReportForVeterinaryComplianceRe')
    expect(name).toHaveLength(56)
  })
})

describe('NameRegistry', () => {
  it('appends numeric suffixes per component type', () => {
    const registry = new NameRegistry()
    expect(registry.getUniqueName('dup', 'tool')).toBe('dup')
    expect(registry.getUniqueName('dup', 'tool')).toBe('dup_2')
    expect(registry.getUniqueName('dup', 'tool')).toBe('dup_3')
    // Different component types count independently.
    expect(registry.getUniqueName('dup', 'resource')).toBe('dup')
  })
})

describe('determineRouteType', () => {
  const maps: RouteMap[] = [
    { methods: ['GET'], pattern: /^\/search$/, mcpType: 'exclude' },
    { methods: ['GET'], pattern: '.*\\{.*', mcpType: 'resourceTemplate', mcpTags: ['templated'] },
    { methods: ['GET'], mcpType: 'resource' },
    ...DEFAULT_ROUTE_MAPPINGS,
  ]

  it('applies user maps in order before the default', () => {
    expect(determineRouteType(makeRoute({ method: 'GET', path: '/search' }), maps).mcpType).toBe(
      'exclude',
    )
    expect(
      determineRouteType(makeRoute({ method: 'GET', path: '/pets/{petId}' }), maps).mcpType,
    ).toBe('resourceTemplate')
    expect(determineRouteType(makeRoute({ method: 'GET', path: '/pets' }), maps).mcpType).toBe(
      'resource',
    )
    expect(determineRouteType(makeRoute({ method: 'POST', path: '/pets' }), maps).mcpType).toBe(
      'tool',
    )
  })

  it('searches patterns unanchored, like Python re.search', () => {
    const result = determineRouteType(makeRoute({ method: 'GET', path: '/api/pets/{id}' }), [
      { pattern: 'pets', mcpType: 'resource' },
    ])
    expect(result.mcpType).toBe('resource')
  })

  it('requires every map tag to be present on the route', () => {
    const tagMaps: RouteMap[] = [{ tags: ['pets', 'read'], mcpType: 'resource' }]
    expect(
      determineRouteType(makeRoute({ tags: ['pets', 'read', 'extra'] }), tagMaps).mcpType,
    ).toBe('resource')
    expect(determineRouteType(makeRoute({ tags: ['pets'] }), tagMaps).mcpType).toBe('tool')
  })

  it('falls back to tool when nothing matches', () => {
    expect(determineRouteType(makeRoute({}), []).mcpType).toBe('tool')
  })

  it('is not confused by a global RegExp lastIndex', () => {
    const pattern = /pets/g
    const maps: RouteMap[] = [{ pattern, mcpType: 'resource' }]
    expect(determineRouteType(makeRoute({ path: '/pets' }), maps).mcpType).toBe('resource')
    expect(determineRouteType(makeRoute({ path: '/pets' }), maps).mcpType).toBe('resource')
  })
})
