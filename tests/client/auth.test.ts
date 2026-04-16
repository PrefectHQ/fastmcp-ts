import { describe, it } from 'vitest'

describe('Client — Authentication', () => {
  describe('Bearer token', () => {
    it.todo('a token string passed to auth is sent as Authorization: Bearer <token>')
    it.todo('does not prepend Bearer if the string already includes it')
  })

  describe('BearerAuth class', () => {
    it.todo('attaches the token to HTTP requests')
    it.todo('can be used in place of a raw token string')
  })

  describe('Custom headers', () => {
    it.todo('arbitrary headers passed to the transport are forwarded on every request')
  })

  describe('OAuth 2.1 + PKCE', () => {
    it.todo('opens the browser to the authorization URL to obtain user consent')
    it.todo('exchanges the authorization code for tokens using PKCE (RFC 7636)')
    it.todo('dynamically registers the client when no client_id is provided (RFC 7591)')
    it.todo('automatically refreshes the access token when it expires')
    it.todo('persists tokens to the configured storage backend')
    it.todo('loads existing tokens from storage and skips the auth flow when valid')
    it.todo('requests the configured scopes during authorization')
  })
})
