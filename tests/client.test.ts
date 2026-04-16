import { describe, it } from 'vitest'

describe('Client', () => {
  describe('transport detection', () => {
    it.todo('connects via streamable HTTP when given an https:// URL string')
    it.todo('connects via SSE when explicitly configured with an SSE transport')
    it.todo('connects via stdio when given a command string')
    it.todo('connects via stdio when given a { command, args } descriptor')
    it.todo('connects in-process when given a server instance')
    it.todo('throws a clear error when given an unrecognisable source')
  })

  describe('lifecycle', () => {
    it.todo('auto-initializes on connect by default')
    it.todo('skips initialization when autoInitialize is false')
    it.todo('exposes initializeResult after connecting')
    it.todo('isConnected() returns false before connect and true after')
    it.todo('isConnected() returns false after close()')
    it.todo('close() is idempotent when called multiple times')
    it.todo('ping() resolves when connected')
    it.todo('ping() rejects when not connected')
    it.todo('supports the `using` keyword via AsyncDisposable for automatic cleanup')
  })
})
