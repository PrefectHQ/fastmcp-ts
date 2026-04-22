import { describe, it } from 'vitest'

describe('Apps — FastMCPApp', () => {
  describe('visibility management', () => {
    it.todo('entry-point tools are visible to the LLM and automatically linked to a ui:// resource')
    it.todo('backend tools are hidden from the LLM by default and only callable from within the rendered UI')
    it.todo('a backend tool can opt in to LLM visibility without losing UI callability')
  })

  describe('composition safety', () => {
    it.todo('tool references in the component tree resolve via stable hashed identifiers, not names')
    it.todo('references survive namespace transforms applied during composition or mounting')
  })

  describe('server integration', () => {
    it.todo('a FastMCPApp instance can be registered as a provider on a FastMCP server')
    it.todo('multiple FastMCPApp instances can be composed on the same server without conflicts')
    it.todo('gracefully degrades when hosted on a server whose client does not advertise UI support')
  })
})
