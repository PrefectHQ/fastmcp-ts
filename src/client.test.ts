import { describe, it } from 'vitest'

describe('Client', () => {
  describe('transport detection', () => {
    it.todo('connects via streamable HTTP when given a URL string')
    it.todo('connects via stdio when given a command descriptor')
    it.todo('connects in-process when given a server instance')
  })

  describe('lifecycle', () => {
    it.todo('auto-initializes on connect by default')
    it.todo('skips initialization when autoInitialize is false')
    it.todo('exposes initializeResult after connecting')
    it.todo('reports isConnected correctly after connect and close')
    it.todo('ping() resolves when connected')
  })
})
