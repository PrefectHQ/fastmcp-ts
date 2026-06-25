import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import type { Plugin } from 'esbuild'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The published ESM server uses extensionless MCP SDK subpath imports that only
// a bundler's resolver handles (hence tsup's mcpSdkPlugin). To run the real
// server under plain Node here, bundle it self-contained to a temp file first,
// reusing that same resolve plugin.
const MCP_SDK_NAMED_EXPORTS = new Set([
  '@modelcontextprotocol/sdk/client',
  '@modelcontextprotocol/sdk/server',
  '@modelcontextprotocol/sdk/validation',
  '@modelcontextprotocol/sdk/validation/ajv',
  '@modelcontextprotocol/sdk/validation/cfworker',
  '@modelcontextprotocol/sdk/experimental',
  '@modelcontextprotocol/sdk/experimental/tasks',
])
const mcpSdkPlugin: Plugin = {
  name: 'mcp-sdk-resolve',
  setup(b) {
    b.onResolve({ filter: /^@modelcontextprotocol\/sdk\// }, (args) => {
      if (MCP_SDK_NAMED_EXPORTS.has(args.path)) return undefined
      if (/\.[cm]?js$/.test(args.path)) return undefined
      return b.resolve(args.path + '.js', { resolveDir: args.resolveDir, kind: args.kind })
    })
  },
}

// ---------------------------------------------------------------------------
// End-to-end: a real Chromium loads the *bundled* browser client and completes
// a real OAuth authorization-code + PKCE flow (popup + postMessage) against a
// real OAuth-protected FastMCP server, then calls a tool.
//
// The app shell, callback page, and client bundle are served on the SAME ORIGIN
// as the MCP server via Playwright route interception. Same-origin avoids CORS
// (OAuth-mode HTTP does not emit CORS headers) and satisfies postMessage origin
// checks. The real OAuth + MCP endpoints (/authorize, /token, /register,
// /.well-known/*, /mcp) pass through untouched to the server.
// ---------------------------------------------------------------------------

let mcp: { address: { port: number }; close(): Promise<void>; tool: (...a: unknown[]) => void }
let baseUrl: string
let clientBundle: string

const APP_HTML =
  '<!doctype html><meta charset="utf-8"><button id="connect">Connect</button>' +
  '<pre id="out">idle</pre><script type="module" src="/e2e-app.js"></script>'

const APP_JS = `
import { Client, BrowserOAuth, IndexedDBStore } from '/e2e-client.js'
document.getElementById('connect').addEventListener('click', async () => {
  const out = document.getElementById('out')
  out.textContent = 'connecting'
  try {
    const base = location.origin
    const client = new Client(base + '/mcp', {
      auth: new BrowserOAuth({ redirectUri: base + '/callback', store: new IndexedDBStore() }),
    })
    await client.connect()
    const tools = await client.listTools()
    out.textContent = 'OK:' + tools.length
  } catch (e) {
    out.textContent = 'ERR:' + (e && e.message ? e.message : String(e))
  }
})
`

test.beforeAll(async () => {
  // Bundle the browser client exactly as a browser bundler would.
  const result = await build({
    entryPoints: ['src/client/index.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  })
  clientBundle = result.outputFiles[0].text

  // Bundle the real server to a self-contained temp module, then load it.
  const serverOut = join(tmpdir(), `fastmcp-e2e-server-${process.pid}.cjs`)
  await build({
    entryPoints: ['src/server/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: serverOut,
    plugins: [mcpSdkPlugin],
  })
  const require = createRequire(import.meta.url)
  const { FastMCP, oauthProvider } = require(serverOut) as {
    FastMCP: new (o: object) => typeof mcp
    oauthProvider: (o?: object) => unknown
  }

  const server = new FastMCP({
    name: 'e2e-server',
    version: '0.0.0',
    oauth: { provider: oauthProvider({ scopes: ['read'] }) },
  })
  server.tool({ name: 'ping', description: 'returns pong' }, () => 'pong')
  await (server as unknown as { run(o: object): Promise<void> }).run({
    transport: 'http',
    port: 0,
    host: '127.0.0.1',
  })
  mcp = server
  baseUrl = `http://127.0.0.1:${mcp.address.port}`
})

test.afterAll(async () => {
  await mcp?.close()
})

test('completes popup OAuth in a real browser and lists tools', async ({ page, context }) => {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (`${url.protocol}//${url.host}` !== baseUrl) return route.continue()
    switch (url.pathname) {
      case '/e2e-app':
        return route.fulfill({ contentType: 'text/html', body: APP_HTML })
      case '/e2e-app.js':
        return route.fulfill({ contentType: 'text/javascript', body: APP_JS })
      case '/e2e-client.js':
        return route.fulfill({ contentType: 'text/javascript', body: clientBundle })
      case '/authorize': {
        // Playwright does not re-route the target of a redirect, so we cannot
        // serve the /callback redirect target directly. Instead, fetch the real
        // 302 WITHOUT following it, take the issued code from its Location, and
        // serve a page at this URL that rewrites its own URL to /callback?code=
        // (via history.replaceState — no navigation) and runs the real
        // handleOAuthCallback(), which posts the code back to the opener.
        const resp = await route.fetch({ maxRedirects: 0 })
        const location = resp.headers()['location'] ?? ''
        const target = new URL(location, baseUrl)
        const search = target.search // ?code=...&state=...
        const html =
          '<!doctype html><meta charset="utf-8"><script type="module">' +
          `import { handleOAuthCallback } from '/e2e-client.js';` +
          `history.replaceState(null, '', '/callback${search}');` +
          `handleOAuthCallback();` +
          '</script>'
        return route.fulfill({ contentType: 'text/html', body: html })
      }
      default:
        // /token, /register, /.well-known/*, /mcp → real server.
        return route.continue()
    }
  })

  // Surface in-page errors to the test log if something goes wrong.
  page.on('pageerror', (e) => console.log('[page:pageerror]', e.message))
  context.on('page', (p) => p.on('pageerror', (e) => console.log('[popup:pageerror]', e.message)))

  await page.goto(`${baseUrl}/e2e-app`)
  const popupPromise = context.waitForEvent('page')
  await page.click('#connect') // user gesture so the popup is not blocked
  const popup = await popupPromise
  await popup.waitForEvent('close').catch(() => {})

  // #out becomes "OK:<toolCount>" only after the full popup OAuth dance,
  // real token exchange, reconnect, and a successful listTools() call.
  await expect(page.locator('#out')).toHaveText(/^OK:\d+/, { timeout: 30_000 })
})
