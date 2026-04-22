import { describe, it } from 'vitest'

describe('CLI', () => {
  describe('version', () => {
    it.todo('prints fastmcp, mcp-sdk, node version, and platform info')
    it.todo('--json outputs version info as machine-readable JSON with the same fields')
  })

  describe('inspect <file>', () => {
    it.todo('lists all tools with their names and descriptions')
    it.todo('lists all resources with their URIs and descriptions')
    it.todo('lists all prompts with their names and descriptions')
    it.todo('--json outputs tools, resources, and prompts as machine-readable JSON')
    it.todo('exits non-zero with an error message when the file does not exist')
    it.todo('shows empty sections gracefully when the server exposes nothing')
  })

  describe('list <server>', () => {
    it.todo('prints tool names and descriptions when connecting via --command')
    it.todo('prints tool names and descriptions when connecting via URL')
    it.todo('--resources includes resource entries in the output')
    it.todo('--prompts includes prompt entries in the output')
    it.todo('--json outputs the full tool/resource/prompt list as machine-readable JSON')
    it.todo('--input-schema prints the full JSON input schema for each tool')
    it.todo('exits non-zero with an error when the server is unreachable')
    it.todo('shows an empty state message when the server exposes no tools')
  })

  describe('call <target> [key=value...]', () => {
    it.todo('invokes the named tool and prints a text result')
    it.todo('invokes a tool and prints structured/non-text results as JSON')
    it.todo('accepts key=value pairs and passes them as tool arguments')
    it.todo('coerces numeric string values (count=5) to the correct JS type')
    it.todo('coerces JSON-stringified values (list=\'["a","b"]\') to their parsed types')
    it.todo('--input-json accepts a full JSON object as the argument set')
    it.todo('key=value pairs override fields already provided by --input-json')
    it.todo('reads a resource by URI and prints its text content')
    it.todo('gets a prompt by name and prints the rendered messages')
    it.todo('suggests the closest match when the tool name is not found')
    it.todo('--json outputs the raw tool result as machine-readable JSON')
    it.todo('exits non-zero when the server returns a tool error')
  })

  describe('discover', () => {
    it.todo('finds MCP servers in a local mcp.json file')
    it.todo('finds MCP servers in a Claude Code config file')
    it.todo('finds MCP servers in a Claude Desktop config file')
    it.todo('finds MCP servers in a Cursor config file')
    it.todo('finds MCP servers in a Gemini config file')
    it.todo('finds MCP servers in a Goose config file')
    it.todo('--source filters results to only the specified config source')
    it.todo('prints server name, transport type, and connection command/URL for each entry')
    it.todo('--json outputs all discovered servers as machine-readable JSON')
    it.todo('shows an empty state when no known config files exist or contain servers')
  })

  describe('install', () => {
    describe('install mcp-json', () => {
      it.todo('creates a new mcp.json and writes the server entry')
      it.todo('adds to an existing mcp.json without clobbering other entries')
      it.todo('--force overwrites an existing entry without prompting')
      it.todo('--args are reflected correctly in the installed config')
      it.todo('--env variables are reflected correctly in the installed config')
      it.todo('exits non-zero and prints a warning when entry already exists in non-TTY without --force')
    })

    describe('install claude-code', () => {
      it.todo('writes the server entry to the Claude Code config file')
      it.todo('--force overwrites a pre-existing entry')
    })

    describe('install claude-desktop', () => {
      it.todo('writes the server entry to the Claude Desktop config file')
    })

    describe('install cursor', () => {
      it.todo('writes the server entry to the Cursor config file')
    })

    describe('install gemini', () => {
      it.todo('writes the server entry to the Gemini config file')
    })

    describe('install goose', () => {
      it.todo('writes the server entry to the Goose YAML config with enabled: true and type: stdio')
      it.todo('--args become the YAML args array in the Goose config')
    })
  })

  describe('run <file>', () => {
    it.todo('starts the server process and its stdout/stderr stream through')
    it.todo('exits non-zero with an error when the server file does not exist')
    it.todo('--transport http starts the server using the HTTP transport')
    it.todo('--reload restarts the server when the source file changes')
  })
})
