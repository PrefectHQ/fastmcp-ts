import { describe, it } from 'vitest'

describe('Server — Prompts', () => {
  describe('declaration', () => {
    it.todo('a registered prompt is discoverable via prompts/list')
    it.todo('name is inferred from the handler function name when not provided in config')
    it.todo('description is inferred from the handler function name when not provided in config')
    it.todo('title is forwarded in list responses when provided')
    it.todo('arguments declared in config are advertised to clients')
  })

  describe('execution', () => {
    it.todo('a string return is delivered as a single user text message')
    it.todo('a PromptMessage return is delivered directly')
    it.todo('an array return is delivered as a multi-turn message sequence')
    it.todo('a PromptResult return is used as-is (escape hatch for description + custom messages)')
    it.todo('async prompt functions are awaited before the response is sent')
    it.todo('missing a required argument returns an error before the handler runs')
    it.todo('optional arguments are omitted without error')
  })

  describe('content types', () => {
    it.todo('handler can return an image content block')
    it.todo('handler can return an embedded resource content block')
  })

  describe('pagination', () => {
    it.todo('prompts/list returns the first page and a nextCursor when results exceed the page size')
    it.todo('supplying a cursor returns the next page of prompts')
  })

  describe('visibility', () => {
    it.todo('a disabled prompt does not appear in list responses')
    it.todo('calling a disabled prompt returns an error')
    it.todo('clients are notified when the prompt list changes')
  })
})
