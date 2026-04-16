import { describe, it } from 'vitest'

describe('Apps — FastMCPApp', () => {
  describe('visibility management', () => {
    it.todo('tools declared with @app.ui() are visible to the LLM as entry points')
    it.todo('tools declared with @app.tool() are hidden from the LLM by default')
    it.todo('hidden tools remain callable from within the UI via CallTool actions')
  })

  describe('composition safety', () => {
    it.todo('tool references in CallTool actions resolve via stable global keys, not names')
    it.todo('references survive namespace transforms applied by composition/mounting')
  })

  describe('server integration', () => {
    it.todo('a FastMCPApp instance can be registered as a provider on a FastMCP server')
    it.todo('multiple FastMCPApp instances can be composed on the same server without conflicts')
  })
})
