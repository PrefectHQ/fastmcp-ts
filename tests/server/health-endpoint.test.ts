import { describe, it, expect, afterEach } from 'vitest'
import { FastMCP } from 'fastmcp-ts/server'
import { stdioPipePair } from '../helpers/stdio'

// ---------------------------------------------------------------------------
// RunOptions.health (issue #75): sugar over the custom-route mechanism.
// Off unless supplied; presence implies enabled; enabled: false forces off.
// Defaults: path /healthz, status 200, body 'ok', text/plain.
// ---------------------------------------------------------------------------

describe('health endpoint', () => {
  let mcp: FastMCP | null = null
  afterEach(async () => {
    await mcp?.close()
    mcp = null
  })

  it('is off when the option is omitted', async () => {
    mcp = new FastMCP({ name: 'health' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    const { port } = mcp.address!

    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(404)
  })

  it('health: true serves the defaults', async () => {
    mcp = new FastMCP({ name: 'health' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', health: true })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toBe('ok')
  })

  it('an object implies enabled and applies overrides', async () => {
    mcp = new FastMCP({ name: 'health' })
    await mcp.run({
      transport: 'http',
      port: 0,
      host: '127.0.0.1',
      health: { path: '/livez', status: 203, body: 'fine' },
    })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez`)
    expect(res.status).toBe(203)
    expect(await res.text()).toBe('fine')
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(404)
  })

  it('enabled: false and health: false force it off', async () => {
    mcp = new FastMCP({ name: 'health' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', health: { enabled: false } })
    const { port } = mcp.address!
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(404)
    await mcp.close()

    mcp = new FastMCP({ name: 'health' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', health: false })
    const { port: port2 } = mcp.address!
    expect((await fetch(`http://127.0.0.1:${port2}/healthz`)).status).toBe(404)
  })

  it('a null-body status (the docs 204 example) serves with no body instead of a 500', async () => {
    // Regression: new Response('', { status: 204 }) throws (fetch spec forbids any
    // body, even '', on 101/204/205/304). The docs' exact example must actually work.
    mcp = new FastMCP({ name: 'health' })
    await mcp.run({
      transport: 'http',
      port: 0,
      host: '127.0.0.1',
      health: { path: '/livez', status: 204, body: '' },
    })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/livez`)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('only answers GET: other methods get 405, like any custom route', async () => {
    mcp = new FastMCP({ name: 'health' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', health: true })
    const { port } = mcp.address!

    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
  })

  it('collides loudly with a user route on the same path', async () => {
    mcp = new FastMCP({ name: 'health' })
    mcp.customRoute({ path: '/healthz' }, () => new Response('mine'))
    await expect(
      mcp.run({ transport: 'http', port: 0, host: '127.0.0.1', health: true }),
    ).rejects.toThrow(/already registered/)
  })

  it('is ignored on stdio when valid', async () => {
    mcp = new FastMCP({ name: 'health' })
    const { clientToServer, serverToClient } = stdioPipePair()
    await expect(
      mcp.run({ transport: 'stdio', stdin: clientToServer, stdout: serverToClient, health: true }),
    ).resolves.toBeUndefined()
  })

  it('a malformed value still aborts stdio startup (stateless precedent)', async () => {
    mcp = new FastMCP({ name: 'health' })
    const { clientToServer, serverToClient } = stdioPipePair()
    await expect(
      mcp.run({
        transport: 'stdio',
        stdin: clientToServer,
        stdout: serverToClient,
        health: 'yes' as unknown as boolean,
      }),
    ).rejects.toThrow(/health/)
  })
})
