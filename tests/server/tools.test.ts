import { describe, it } from 'vitest'

describe('Server — Tools', () => {
  describe('declaration', () => {
    it.todo('a function registered as a tool is discoverable by clients')
    it.todo('name and description are inferred from the function when not provided explicitly')
    it.todo('input schema is generated from the parameter definitions')
    it.todo('output schema is generated from the return type annotation')
    it.todo('a tool can be registered with explicit name, description, and metadata')
  })

  describe('execution', () => {
    it.todo('sync tools execute and return their result to the client')
    it.todo('async tools are awaited and their result returned to the client')
    it.todo('a tool that throws returns an error result rather than crashing the server')
    it.todo('a tool that exceeds its timeout returns a timeout error to the client')
  })

  describe('input handling', () => {
    it.todo('required parameters must be provided or the call is rejected')
    it.todo('optional parameters default correctly when omitted')
    it.todo('input is validated against the schema before the function is called')
    it.todo('structured output is returned alongside text content when the return type warrants it')
  })

  describe('visibility', () => {
    it.todo('a disabled tool does not appear in list responses')
    it.todo('tools can be filtered by tag')
  })
})
