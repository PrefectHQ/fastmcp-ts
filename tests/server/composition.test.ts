import { describe, it } from 'vitest'

describe('Server — Composition', () => {
  describe('mounting', () => {
    it.todo('a mounted server\'s tools are accessible via the parent')
    it.todo('a mounted server\'s resources are accessible via the parent')
    it.todo('a mounted server\'s prompts are accessible via the parent')
    it.todo('tools added to a child server after mounting immediately appear in the parent')
  })

  describe('namespacing', () => {
    it.todo('a namespace prefix prevents name collisions across mounted servers')
    it.todo('a namespaced tool call is routed to the correct child server')
  })

  describe('proxying', () => {
    it.todo('a remote HTTP server can be mounted as a proxy')
    it.todo('a subprocess server can be mounted as a proxy')
    it.todo('tools on the proxied server are callable via the parent')
  })
})
