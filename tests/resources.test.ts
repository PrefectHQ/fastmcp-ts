import { describe, it } from 'vitest'

describe('Resources', () => {
  describe('listResources()', () => {
    it.todo('returns an array of static resource definitions with uri and name')
  })

  describe('listResourceTemplates()', () => {
    it.todo('returns an array of URI template definitions')
    it.todo('each template includes the URI pattern and parameter descriptions')
  })

  describe('readResource()', () => {
    it.todo('returns text content for a text resource')
    it.todo('returns binary blob content for a binary resource')
    it.todo('includes the MIME type on returned content')
    it.todo('accepts a version argument to target a specific resource version')
    it.todo('resolves parameterised template URIs correctly')
    it.todo('throws when the requested URI does not exist')
  })

  describe('readResourceRaw()', () => {
    it.todo('returns the full MCP ReadResourceResult object unmodified')
  })
})
