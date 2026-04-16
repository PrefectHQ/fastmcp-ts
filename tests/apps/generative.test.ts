import { describe, it } from 'vitest'

describe('Apps — Generative UI', () => {
  describe('LLM-driven rendering', () => {
    it.todo('the LLM is given a tool to generate and execute UI component code')
    it.todo('the LLM is given a tool to discover available components and their APIs')
    it.todo('generated component code executes in an isolated sandbox')
    it.todo('the resulting UI is streamed to the host for progressive rendering')
  })

  describe('server integration', () => {
    it.todo('GenerativeUI can be registered as a provider on a FastMCP server')
    it.todo('its tools are scoped and do not conflict with user-defined tools')
  })
})
