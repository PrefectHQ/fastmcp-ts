import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// To run the real server under plain Node here, bundle it self-contained to a
// temp file first. v2 MCP SDK packages ship well-formed package.json "exports"
// maps for every public subpath, so esbuild resolves them natively — no
// resolve-plugin workaround needed (unlike v1's extensionless subpath imports).

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

const POPUP_APP_JS = `
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

// Deferred mode connects on page load, with no user gesture: connect() fails
// with AuthorizationRequiredError, and the popup opens when Authorize is clicked.
const DEFERRED_APP_JS = `
import { AuthorizationRequiredError, Client, BrowserOAuth } from '/e2e-client.js'
const out = document.getElementById('out')
const authorize = document.createElement('button')
authorize.id = 'authorize'
authorize.textContent = 'Authorize'
authorize.hidden = true
document.body.append(authorize)
const serverUrl = location.origin + '/mcp'
const auth = new BrowserOAuth({ redirectUri: location.origin + '/callback', mode: 'deferred' })
const client = new Client(serverUrl, { auth })
async function connect() {
  try {
    await client.connect()
  } catch (error) {
    if (!(error instanceof AuthorizationRequiredError)) throw error
    authorize.hidden = false
    authorize.onclick = () => { out.textContent = error.openPopup() ? 'authorizing' : 'blocked' }
    await auth.completeAuthorization(serverUrl)
    await client.connect()
  }
  const tools = await client.listTools()
  out.textContent = 'OK:' + tools.length
}
connect().catch((e) => { out.textContent = 'ERR:' + (e && e.message ? e.message : String(e)) })
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

/**
 * Serves the app shell, its script, and the client bundle on the server's
 * origin, plus an /authorize stand-in that hands the real authorization code to
 * the real handleOAuthCallback(). `authorizeHeaders` lets a test send the
 * headers a real provider's consent page would, such as
 * Cross-Origin-Opener-Policy.
 */
async function routeApp(
  context: BrowserContext,
  appJs: string,
  authorizeHeaders: Record<string, string> = {},
): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (`${url.protocol}//${url.host}` !== baseUrl) return route.continue()
    switch (url.pathname) {
      case '/e2e-app':
        return route.fulfill({ contentType: 'text/html', body: APP_HTML })
      case '/e2e-app.js':
        return route.fulfill({ contentType: 'text/javascript', body: appJs })
      case '/e2e-client.js':
        return route.fulfill({ contentType: 'text/javascript', body: clientBundle })
      case '/authorize': {
        // Playwright does not re-route the target of a redirect, so we cannot
        // serve the /callback redirect target directly. Instead, fetch the real
        // 302 WITHOUT following it, take the issued code from its Location, and
        // serve a page at this URL that rewrites its own URL to /callback?code=
        // (via history.replaceState — no navigation) and runs the real
        // handleOAuthCallback(), which reports the code back to the app.
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
        return route.fulfill({ contentType: 'text/html', headers: authorizeHeaders, body: html })
      }
      default:
        // /token, /register, /.well-known/*, /mcp → real server.
        return route.continue()
    }
  })
}

function logPageErrors(page: Page, context: BrowserContext): void {
  page.on('pageerror', (e) => console.log('[page:pageerror]', e.message))
  context.on('page', (p) => p.on('pageerror', (e) => console.log('[popup:pageerror]', e.message)))
}

test('completes popup OAuth in a real browser and lists tools', async ({ page, context }) => {
  await routeApp(context, POPUP_APP_JS)
  logPageErrors(page, context)

  await page.goto(`${baseUrl}/e2e-app`)
  const popupPromise = context.waitForEvent('page')
  await page.click('#connect') // user gesture so the popup is not blocked
  const popup = await popupPromise
  await popup.waitForEvent('close').catch(() => {})

  // #out becomes "OK:<toolCount>" only after the full popup OAuth dance,
  // real token exchange, reconnect, and a successful listTools() call.
  await expect(page.locator('#out')).toHaveText(/^OK:\d+/, { timeout: 30_000 })
})

test('completes popup OAuth when the provider page severs window.opener', async ({ page, context }) => {
  // Cross-Origin-Opener-Policy on the consent page moves the popup into a new
  // browsing context group, so window.opener stays null even after the popup
  // returns to the app's origin. Only the BroadcastChannel reply gets through.
  await routeApp(context, POPUP_APP_JS, { 'Cross-Origin-Opener-Policy': 'same-origin' })
  logPageErrors(page, context)

  await page.goto(`${baseUrl}/e2e-app`)
  await page.click('#connect')

  await expect(page.locator('#out')).toHaveText(/^OK:\d+/, { timeout: 30_000 })
})

test('deferred mode connects on load and opens the popup on a click', async ({ page, context }) => {
  await routeApp(context, DEFERRED_APP_JS)
  logPageErrors(page, context)

  await page.goto(`${baseUrl}/e2e-app`)
  const authorize = page.locator('#authorize')
  await expect(authorize).toBeVisible({ timeout: 30_000 })
  await authorize.click()

  await expect(page.locator('#out')).toHaveText(/^OK:\d+/, { timeout: 30_000 })
})
