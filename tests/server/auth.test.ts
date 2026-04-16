import { describe, it } from 'vitest'

describe('Server — Authentication', () => {
  describe('token validation', () => {
    it.todo('a valid JWT from a trusted issuer grants access to the server')
    it.todo('an expired or tampered token is rejected')
    it.todo('claims from the validated token are available to tools via context')
  })

  describe('OAuth with Dynamic Client Registration', () => {
    it.todo('a client without credentials can register dynamically and obtain tokens')
    it.todo('registered clients authenticate successfully on subsequent requests')
  })

  describe('OAuth proxy', () => {
    it.todo('the proxy presents a DCR-compliant interface to MCP clients')
    it.todo('the proxy uses pre-registered credentials when talking to the upstream provider')
  })

  describe('multi-source auth', () => {
    it.todo('sources are tried in order and the first successful one grants access')
    it.todo('access is denied only when all sources reject the request')
  })
})
