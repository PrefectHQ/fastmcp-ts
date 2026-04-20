import { describe, it } from 'vitest'

describe('Server — Tools', () => {
  describe('declaration', () => {
    it.todo('a function registered as a tool is discoverable by clients via listTools')
    it.todo('name and description are inferred from the function when not provided in config')
    it.todo('an input schema provided as a Standard Schema validator is serialised as inputSchema for clients')
    it.todo('an output schema provided as a Standard Schema validator is advertised as outputSchema for clients')
    it.todo('explicit name, description, and metadata in config override any inferred values')
  })

  describe('execution', () => {
    it.todo('a synchronous handler executes and returns its result to the client')
    it.todo('an async handler is awaited and its result returned to the client')
    it.todo('an exception thrown by the handler is returned as an error result, not a server crash')
    it.todo('a handler that exceeds its configured timeout returns a timeout error to the client')
  })

  describe('input handling', () => {
    it.todo('arguments are validated against the Standard Schema before the handler is called')
    it.todo('a call with missing required parameters is rejected before the handler runs')
    it.todo('optional parameters receive their default values when omitted')
    it.todo('the validated, typed arguments are passed to the handler — not the raw unvalidated input')
  })

  describe('return value conversion', () => {
    it.todo('a string return becomes a single text content block')
    it.todo('a number return is stringified into a text content block')
    it.todo('a boolean return is stringified into a text content block')
    it.todo('undefined or void returns an empty content list')
    it.todo('a plain object return produces a JSON text block and populates structuredContent')
    it.todo('an array return produces a JSON text block and populates structuredContent')
    it.todo('an Image(buffer, mimeType) return produces an image content block')
    it.todo('a File(buffer, name, mimeType) return produces a resource content block with the correct MIME type')
    it.todo('a ToolResult return is passed through as-is, bypassing all automatic conversion')
  })

  describe('visibility', () => {
    it.todo('a tool registered with disabled: true does not appear in listTools responses')
    it.todo('a disabled tool remains callable when invoked directly')
    it.todo('listTools can be filtered to tools matching a given tag')
  })

  describe('dynamic registration', () => {
    it.todo('a tool registered after run() is immediately visible to clients via listTools')
    it.todo('registering a tool on a running server emits a tools/list_changed notification')
  })
})
