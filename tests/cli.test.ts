import { describe, it } from 'vitest'

describe('CLI', () => {
  describe('list <server>', () => {
    it.todo('prints each tool name and its parameter signature')
    it.todo('--resources includes resource definitions in the output')
    it.todo('--prompts includes prompt definitions in the output')
    it.todo('--json outputs the full tool/resource/prompt list as machine-readable JSON')
    it.todo('--input-schema prints the full JSON input schema for each tool')
    it.todo('--output-schema prints the full JSON output schema for each tool')
  })

  describe('call <server> <tool> [key=value...]', () => {
    it.todo('invokes the named tool and prints the result')
    it.todo('coerces string CLI values to the correct types using the tool input schema')
    it.todo('--input-json accepts a JSON object as the base argument set')
    it.todo('key=value pairs override fields provided by --input-json')
    it.todo('prints a friendly error when a required argument is missing')
  })

  describe('discover', () => {
    it.todo('finds MCP servers configured in Claude Desktop')
    it.todo('finds MCP servers configured in Claude Code')
    it.todo('finds MCP servers configured in Cursor')
    it.todo('prints server names and connection details in a readable format')
    it.todo('--json outputs discovered servers as machine-readable JSON')
  })
})
