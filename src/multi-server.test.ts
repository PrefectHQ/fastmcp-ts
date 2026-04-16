import { describe, it } from 'vitest'

describe('Multi-server', () => {
  describe('MCPConfig', () => {
    it.todo('accepts a configuration object describing multiple servers')
    it.todo('establishes a connection to each configured server on connect()')
    it.todo('closes all server connections on close()')
  })

  describe('namespacing', () => {
    it.todo('tools from each server are prefixed with the server name')
    it.todo('resources from each server are prefixed with the server name')
    it.todo('listTools() returns the merged, namespaced tool list across all servers')
    it.todo('callTool() routes to the correct server based on the namespace prefix')
    it.todo('readResource() routes to the correct server based on the namespace prefix')
  })

  describe('per-server configuration', () => {
    it.todo('each server entry can specify its own transport')
    it.todo('each server entry can specify its own auth configuration')
  })
})
