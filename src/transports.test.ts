import { describe, it } from 'vitest'

describe('Transports', () => {
  describe('Stdio', () => {
    it.todo('spawns a process with the given command and args')
    it.todo('does not inherit the shell environment by default')
    it.todo('passes explicitly provided env vars to the spawned process')
    it.todo('spawns the process in the given cwd')
    it.todo('keepAlive maintains the session between calls')
    it.todo('terminates the child process on close()')
  })

  describe('Streamable HTTP', () => {
    it.todo('attaches custom headers to every request')
    it.todo('rejectUnauthorized: false allows self-signed TLS certificates')
    it.todo('rejects connections to servers with invalid certs by default')
  })

  describe('SSE', () => {
    it.todo('attaches custom headers to the SSE connection')
    it.todo('falls back gracefully when the server closes the stream')
  })

  describe('In-process', () => {
    it.todo('communicates without any network or subprocess overhead')
    it.todo('shares the same memory space as the calling code')
  })
})
