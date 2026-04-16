import { describe, it } from 'vitest'

describe('Client — Roots', () => {
  describe('static roots', () => {
    it.todo('an array of paths provided at construction is sent to the server when roots are requested')
    it.todo('paths are normalised to absolute URIs before being sent')
  })

  describe('dynamic roots', () => {
    it.todo('an async callback is invoked when the server requests roots')
    it.todo('the callback receives a RequestContext containing the request metadata')
    it.todo('the return value of the callback is sent to the server as the roots list')
  })
})
