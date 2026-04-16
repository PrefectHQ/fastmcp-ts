import { describe, it } from 'vitest'

describe('Server — Prompts', () => {
  describe('declaration', () => {
    it.todo('a function registered as a prompt is discoverable by clients')
    it.todo('name and description are inferred from the function when not provided explicitly')
    it.todo('parameter schema is generated from function arguments')
  })

  describe('execution', () => {
    it.todo('a simple string return is delivered as a user message')
    it.todo('a multi-turn conversation sequence is returned in full')
    it.todo('async prompt functions are awaited before the response is sent')
  })

  describe('visibility', () => {
    it.todo('a disabled prompt does not appear in list responses')
    it.todo('clients are notified when the prompt list changes')
  })
})
