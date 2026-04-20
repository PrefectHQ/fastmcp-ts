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
    it.todo('a function returning a plain object gets JSON-serialised into a text/json response')
  })

  describe('URI templates', () => {
    it.todo('a URI template is listed as a resource template, not a static resource')
    it.todo('parameters in the URI pattern are extracted and passed to the function')
    it.todo('wildcard path segments capture multiple URI segments')
    it.todo('query parameters are extracted and passed as optional arguments')
    it.todo('reading a URI matching a template calls the handler with extracted parameters')
  })

  describe('pagination', () => {
    it.todo('resources/list returns the first page and a nextCursor when results exceed the page size')
    it.todo('supplying a cursor returns the next page of resources')
    it.todo('resources/templates/list is also paginated with cursor support')
  })

  describe('error handling', () => {
    it.todo('reading an unknown URI returns an error response')
  })

  describe('subscriptions', () => {
    it.todo('a client can subscribe to a resource URI')
    it.todo('the server sends notifications/resources/updated when a subscribed resource changes')
    it.todo('a client can unsubscribe and no longer receives update notifications')
    it.todo('the server advertises the subscribe and listChanged capabilities when enabled')
  })

  describe('visibility and lifecycle', () => {
    it.todo('a disabled resource does not appear in list responses')
    it.todo('clients are notified when the resource list changes')
  })
})
