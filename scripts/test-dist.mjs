/**
 * Smoke test for compiled dist artifacts.
 *
 * Run with plain `node` (no transpiler) so module resolution matches what a
 * consumer's Node.js runtime actually does. This catches ERR_MODULE_NOT_FOUND
 * errors that TypeScript compilation and Vitest (via tsx/Vite) both miss.
 *
 * Add new imports here whenever a new public export is introduced.
 */

import { Client, MultiServerClient, BearerAuth, OAuth, StdioTransport } from '../dist/client.js'
import { FastMCP, createProxy } from '../dist/server.js'
import { Readable, Writable } from 'node:stream'

const required = { Client, MultiServerClient, BearerAuth, OAuth, StdioTransport, FastMCP, createProxy }
const missing = Object.entries(required).filter(([, v]) => v === undefined).map(([k]) => k)

if (missing.length) {
  console.error(`✗ Missing exports: ${missing.join(', ')}`)
  process.exit(1)
}

const stdioServer = new FastMCP({ name: 'dist-stdio-smoke', version: '1.0.0' })
await stdioServer.run({ transport: 'stdio', stdin: Readable.from([]), stdout: new Writable({ write(_chunk, _encoding, callback) { callback() } }) })
await stdioServer.close()

const httpServer = new FastMCP({ name: 'dist-http-smoke', version: '1.0.0' })
await httpServer.run({ transport: 'http', host: '127.0.0.1', port: 0 })

const { host, port, path } = httpServer.address
const httpProxy = await createProxy({ type: 'http', url: `http://${host}:${port}${path}` })
await httpProxy.close()
await httpServer.close()

const backendScript = `const { FastMCP } = await import(${JSON.stringify(new URL('../dist/server.js', import.meta.url).href)})
await new FastMCP({ name: 'dist-proxy-backend', version: '1.0.0' }).run({ transport: 'stdio' })`
const stdioProxy = await createProxy({
  type: 'stdio',
  command: process.execPath,
  args: ['--input-type=module', '-e', backendScript],
})
await stdioProxy.close()

console.log('✓ dist exports, run transports, and proxy transports resolve')
