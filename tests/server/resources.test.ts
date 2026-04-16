import { describe, it } from 'vitest'

describe('Server — Resources', () => {
  describe('static resources', () => {
    it.todo('a static text resource is readable by clients at its declared URI')
    it.todo('a static file resource serves the file contents')
    it.todo('a static binary resource returns blob content with the correct MIME type')
  })

  describe('dynamic resources', () => {
    it.todo('a function-backed resource executes when its URI is requested')
    it.todo('async resource functions are awaited before the response is sent')
  })

  describe('URI templates', () => {
    it.todo('a URI template is listed as a resource template, not a static resource')
    it.todo('parameters in the URI pattern are extracted and passed to the function')
    it.todo('wildcard path segments capture multiple URI segments')
    it.todo('query parameters are extracted and passed as optional arguments')
  })

  describe('visibility and lifecycle', () => {
    it.todo('a disabled resource does not appear in list responses')
    it.todo('clients are notified when the resource list changes')
  })
})
