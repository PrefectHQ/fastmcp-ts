import { describe, it } from 'vitest'

describe('Apps — Generative UI', () => {
  describe('LLM-driven rendering', () => {
    it.todo('the LLM is given a generate_ui tool to generate and execute UI component code at runtime')
    it.todo('the LLM is given a search_components tool to discover available component APIs and signatures')
    it.todo('generated component code executes in an isolated sandbox')
    it.todo('the resulting UI is streamed to the host for progressive rendering via partial tool arguments')
    it.todo('partial component trees render incrementally as the LLM produces the code')
  })

  describe('server integration', () => {
    it.todo('GenerativeUI can be registered as a provider on a FastMCP server')
    it.todo('its tools are scoped and do not conflict with user-defined tools')
  })
})
