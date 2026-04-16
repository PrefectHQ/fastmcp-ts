import { describe, it } from 'vitest'

describe('Client — Tools', () => {
  describe('listTools()', () => {
    it.todo('returns an array of tool definitions')
    it.todo('each definition includes name, description, and inputSchema')
  })

  describe('callTool()', () => {
    it.todo('returns parsed text content from the tool result')
    it.todo('returns structured content when the tool provides it')
    it.todo('passes arguments to the server verbatim')
    it.todo('throws when the server returns an error result')
  })

  describe('callToolRaw()', () => {
    it.todo('returns the full MCP CallToolResult object unmodified')
  })

  describe('typed responses', () => {
    it.todo('validates structuredContent against a caller-supplied Zod schema')
    it.todo('returns a typed value when the schema matches')
    it.todo('throws a validation error when structuredContent does not match the schema')
  })
})
