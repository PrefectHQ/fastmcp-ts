import { describe, it } from 'vitest'

describe('Server — Context', () => {
  describe('injection', () => {
    it.todo('a tool that declares a Context parameter receives one at call time')
    it.todo('resources and prompts can also receive a Context parameter')
  })

  describe('logging', () => {
    it.todo('log messages emitted via context are forwarded to the connected client')
    it.todo('all severity levels (debug through emergency) are transmitted correctly')
  })

  describe('progress reporting', () => {
    it.todo('progress notifications emitted via context are forwarded to the client')
  })

  describe('LLM sampling', () => {
    it.todo('a sampling request via context is forwarded to the client for fulfillment')
    it.todo('the client response is returned to the tool as the sampling result')
  })

  describe('user elicitation', () => {
    it.todo('an elicitation request via context is forwarded to the client')
    it.todo('the client response (accept / decline / cancel) is returned to the tool')
  })

  describe('session state', () => {
    it.todo('values stored in session state persist across requests within the same session')
    it.todo('session state is isolated between different client sessions')
  })
})
