# Browser-Buildable Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `import { Client } from 'fastmcp/client'` bundle and run in a browser — HTTP+SSE transports, Bearer auth, a browser token store, and full browser OAuth (popup default + redirect mode) — without breaking any existing Node behavior.

**Architecture:** Keep the single `./client` entry point. Convert the four Node-only static imports (stdio transport, OAuth `http` callback server + `spawn` browser-opener, `FileTokenStorage` `fs`, root-normalization `node:path`/`node:url`) into on-demand dynamic `import()`s, and add a `package.json` `"browser"` field that maps those Node built-ins to `false` so bundlers don't choke. Then add browser-safe primitives (`IndexedDBStore`, `LocalStorageStore`, `BrowserOAuth extends OAuth`, `handleOAuthCallback`). `BrowserOAuth` extends `OAuth`, so the existing `client.ts` auth flow (`instanceof OAuth` → `waitForCallback` → `finishAuth` → reconnect) works unchanged.

**Tech Stack:** TypeScript (ES2022, ESM), `@modelcontextprotocol/sdk` ^1.29, tsup (esbuild), vitest (+ jsdom + fake-indexeddb for browser units), Playwright (Chromium e2e), esbuild (bundle smoke test).

## Global Constraints

- Package name `@prefecthq/fastmcp-ts`; `"type": "module"`; Node `>=22`. Copy these verbatim into any config edits.
- Public client API must not change except for **new** exports (`IndexedDBStore`, `LocalStorageStore`, `BrowserOAuth`, `handleOAuthCallback`, their option types). Do not rename or remove existing exports.
- All existing tests under `tests/` must stay green after every task. Run `npm test` before each commit.
- Tests mirror `src/` under `tests/` (e.g. `src/client/auth.ts` → `tests/client/auth.test.ts`). Follow that convention.
- Browser-only globals (`window`, `indexedDB`, `localStorage`) must be referenced **inside methods**, never at module top level, so the modules remain importable (they may throw when used) under Node.
- Node-only built-ins (`child_process`, `fs`, `fs/promises`, `http`, `os`, `node:path`, `node:url`, and `@modelcontextprotocol/sdk/client/stdio.js`) must never appear in the static import graph reachable from `src/client/index.ts`. The Task 5 smoke test enforces this.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. Commit after every task.

---

## File Structure

**Modified (Phase A — make Node code lazy):**
- `src/client/transports.ts` — `resolveTransport`/`resolveEntryTransport` become `async`; stdio loaded via dynamic import.
- `src/client/client.ts:177` — `await resolveTransport(...)`; root normalization made lazy/browser-safe.
- `src/client/multi-server.ts:108` — `await resolveEntryTransport(...)`.
- `src/client/auth.ts` — OAuth `http`/`spawn` and `FileTokenStorage` `fs`/`os`/`path` made lazy.
- `package.json` — add `"browser"` field + `"sideEffects"`.

**Created (verification):**
- `scripts/test-browser-bundle.mjs` — esbuild bundle + Node-builtin assertion.

**Modified/Created (Phase B — browser primitives):**
- `src/client/auth/` — split `auth.ts` into `stores.ts`, `file-storage.ts`, `oauth.ts`, `browser-oauth.ts`, `bearer.ts`, `client-credentials.ts`, `index.ts`.
- `src/client/index.ts` — export new browser symbols.
- `tests/client/stores.test.ts`, `tests/client/browser-oauth.test.ts` — jsdom units.

**Created (Phase C — e2e):**
- `tests/browser/oauth-e2e.spec.ts` + mock server — Playwright Chromium.
- `playwright.config.ts`.

---

## Task 1: Make the stdio transport lazy in `transports.ts`

**Files:**
- Modify: `src/client/transports.ts`
- Modify: `src/client/client.ts:177`
- Modify: `src/client/multi-server.ts:108`
- Test: `tests/client/transports.test.ts`

**Interfaces:**
- Produces: `resolveTransport(input, auth?): Promise<ResolvedTransport>` (now async); `resolveEntryTransport(entry, auth?): Promise<ResolvedTransport>` (now async). `ResolvedTransport` unchanged.
- Consumes: SDK `StdioClientTransport` via `await import('@modelcontextprotocol/sdk/client/stdio.js')`.

- [ ] **Step 1: Write the failing test** — add to `tests/client/transports.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveTransport, StdioTransport } from '../../src/client/transports.js'

describe('resolveTransport (async)', () => {
  it('resolves a URL string to a transport via a promise', async () => {
    const { transport } = await resolveTransport('https://example.com/mcp')
    expect(transport).toBeDefined()
    expect(typeof (transport as { start?: unknown }).start).toBe('function')
  })

  it('lazily loads stdio only when a StdioTransport is given', async () => {
    const { transport } = await resolveTransport(
      new StdioTransport('node', ['server.js']),
    )
    expect(transport).toBeDefined()
    expect(transport.constructor.name).toBe('StdioClientTransport')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/transports.test.ts -t "async"`
Expected: FAIL — `resolveTransport(...).transport` is `undefined` because the current sync function returns an object, not a promise (`await` on a non-promise yields the object, so `.transport` works, but the stdio test fails on `constructor.name` only after async conversion). If it passes spuriously, proceed — Step 3 still required for the lazy-import goal.

- [ ] **Step 3: Implement** — in `src/client/transports.ts`, remove the top-level stdio import (line 6) and add a lazy helper + make both resolvers async.

Delete:
```ts
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
```

Add near the other helpers:
```ts
async function createStdioTransport(opts: {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}): Promise<Transport> {
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  )
  return new StdioClientTransport(opts)
}
```

Change `resolveEntryTransport` signature to `export async function resolveEntryTransport(...): Promise<ResolvedTransport>` and replace the `new StdioClientTransport({...})` block (lines 233-240) with:
```ts
  const cmd = entry as { command: string; args?: string[]; env?: Record<string, string> }
  return { transport: await createStdioTransport({ command: cmd.command, args: cmd.args, env: cmd.env }) }
```

Change `resolveTransport` signature to `export async function resolveTransport(...): Promise<ResolvedTransport>`. Replace the `StdioTransport` branch (lines 260-269) with:
```ts
  if (input instanceof StdioTransport) {
    return {
      transport: await createStdioTransport({
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: input.cwd,
      }),
    }
  }
```
And change the config-object branch (line 292) to `return await resolveEntryTransport(entry, auth)`.

- [ ] **Step 4: Update callers**

`src/client/client.ts:177` →
```ts
    const { transport, beforeConnect } = await resolveTransport(this._input, this._auth)
```

`src/client/multi-server.ts:108-110` →
```ts
          const { transport, beforeConnect } = await resolveEntryTransport(
            entry as McpServerValue,
          )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/client/transports.test.ts tests/client/multi-server.test.ts tests/client/client.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/client/transports.ts src/client/client.ts src/client/multi-server.ts tests/client/transports.test.ts
git commit -m "refactor(client): load stdio transport lazily so the client graph is browser-safe"
```

---

## Task 2: Make the OAuth `http` callback server and `spawn` browser-opener lazy

**Files:**
- Modify: `src/client/auth.ts`
- Test: `tests/client/auth.test.ts`

**Interfaces:**
- Produces: `OAuth` class — public surface unchanged. Internally, `http` and `child_process` are dynamically imported only when the localhost callback flow runs.

- [ ] **Step 1: Write the failing test** — add to `tests/client/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { OAuth } from '../../src/client/auth.js'

describe('OAuth lazy node deps', () => {
  it('constructs and exposes redirect metadata without importing node http/child_process', () => {
    const oauth = new OAuth({ clientId: 'abc', callbackPort: 9999 })
    expect(oauth.redirectUrl).toBe('http://localhost:9999/callback')
    expect(oauth.clientMetadata.redirect_uris).toEqual(['http://localhost:9999/callback'])
  })

  it('uses onRedirect override instead of spawning a browser', async () => {
    const seen: string[] = []
    const oauth = new OAuth({ callbackPort: 0, onRedirect: (u) => { seen.push(u.toString()) } })
    oauth._bind('https://srv.example')
    await oauth.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'))
    expect(seen).toHaveLength(1)
    // Clean up the callback server started by redirectToAuthorization.
    void oauth.waitForCallback(1).catch(() => {})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/auth.test.ts -t "lazy node deps"`
Expected: PASS for metadata, but the goal is the import refactor in Step 3. (This test pins behavior across the refactor; if green now, it must stay green after Step 3.)

- [ ] **Step 3: Implement** — in `src/client/auth.ts`:

Remove the top-level `import { spawn } from 'child_process'` (line 8) and `import * as http from 'http'` (line 10). Keep `homedir`/`fs`/`path` for now (Task 3 handles those).

Change the field type `private _callbackServer: http.Server | null = null` to:
```ts
  private _callbackServer: { close(): void } | null = null
```

In `_startCallbackServer`, dynamically import `http`:
```ts
  private async _startCallbackServer(): Promise<void> {
    if (this._callbackServer) return
    const http = await import('http')
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // ... unchanged body ...
      })
      server.on('error', reject)
      server.listen(this._callbackPort, () => {
        const addr = server.address()
        if (addr && typeof addr !== 'string') this._actualCallbackPort = addr.port
        this._callbackServer = server
        resolve()
      })
    })
  }
```
(`redirectToAuthorization` already `await`s `_startCallbackServer()`, so no caller change.)

Rewrite `openBrowser` to import `child_process` lazily and make it async; update the call site in `redirectToAuthorization`:
```ts
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('child_process')
  const platform = process.platform
  if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
  else if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' })
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
}
```
In `redirectToAuthorization`, change `openBrowser(authorizationUrl.toString())` to `await openBrowser(authorizationUrl.toString())`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/client/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/auth.ts tests/client/auth.test.ts
git commit -m "refactor(client): load OAuth http callback server and browser-opener lazily"
```

---

## Task 3: Make `FileTokenStorage` filesystem access lazy

**Files:**
- Modify: `src/client/auth.ts`
- Test: `tests/client/auth.test.ts`

**Interfaces:**
- Produces: `FileTokenStorage` — public surface unchanged (`get`/`set`/`delete`, optional `path` ctor arg). `fs`/`os`/`path` imported on first method call.

- [ ] **Step 1: Write the failing test** — add to `tests/client/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileTokenStorage } from '../../src/client/auth.js'

describe('FileTokenStorage (lazy fs)', () => {
  it('round-trips a value through an explicit path', async () => {
    const path = join(tmpdir(), `fastmcp-test-${process.pid}.json`)
    const store = new FileTokenStorage(path)
    await store.set('k', 'v')
    expect(await store.get('k')).toBe('v')
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails/passes**

Run: `npx vitest run tests/client/auth.test.ts -t "lazy fs"`
Expected: PASS now (behavior unchanged); must stay PASS after Step 3.

- [ ] **Step 3: Implement** — in `src/client/auth.ts`, remove top-level `import * as fs from 'fs/promises'` (line 9), `import { homedir } from 'os'` (line 11), `import { dirname, join } from 'path'` (line 12). Rewrite `FileTokenStorage`:

```ts
export class FileTokenStorage implements KeyValueStore {
  private readonly _explicitPath?: string
  private _resolvedPath?: string

  constructor(path?: string) {
    this._explicitPath = path
  }

  private async _path(): Promise<string> {
    if (this._resolvedPath) return this._resolvedPath
    if (this._explicitPath) return (this._resolvedPath = this._explicitPath)
    const { homedir } = await import('os')
    const { join } = await import('path')
    return (this._resolvedPath = join(homedir(), '.fastmcp', 'tokens.json'))
  }

  private async _readAll(): Promise<Record<string, string>> {
    const fs = await import('fs/promises')
    try {
      const raw = await fs.readFile(await this._path(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, string>
      }
      return {}
    } catch {
      return {}
    }
  }

  private async _writeAll(data: Record<string, string>): Promise<void> {
    const fs = await import('fs/promises')
    const { dirname } = await import('path')
    const path = await this._path()
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, path)
  }

  async get(key: string): Promise<string | null> {
    const data = await this._readAll()
    return data[key] ?? null
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this._readAll()
    data[key] = value
    await this._writeAll(data)
  }

  async delete(key: string): Promise<void> {
    const data = await this._readAll()
    if (!(key in data)) return
    delete data[key]
    await this._writeAll(data)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/client/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/auth.ts tests/client/auth.test.ts
git commit -m "refactor(client): load FileTokenStorage fs/os/path lazily"
```

---

## Task 4: Make root-URI normalization browser-safe

**Files:**
- Modify: `src/client/client.ts` (lines 1-2 imports; `normalizeRootsOption`/`normalizeRootInput`/`normalizeRootUri` ~560-576)
- Test: `tests/client/roots.test.ts`

**Interfaces:**
- Produces: `normalizeRootsOption(roots: RootsValue): () => Promise<Root[]>` (unchanged signature). Normalization is now async internally and loads `node:path`/`node:url` lazily; an already-`file://`/scheme URI passes through without any Node import.

- [ ] **Step 1: Write the failing test** — add to `tests/client/roots.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Client } from '../../src/client/client.js'

// Roots normalization should pass through file:// URIs untouched (no node import path).
describe('root normalization', () => {
  it('passes through file:// URIs unchanged', async () => {
    const c = new Client('https://example.com/mcp', { roots: ['file:///abs/path'] })
    const handler = (c as unknown as { _rootsCallback?: () => Promise<{ uri: string }[]> })._rootsCallback
    // Fallback: assert via the public roots option round-trip if no internal handle.
    expect(c).toBeDefined()
  })
})
```

> NOTE for implementer: if `Client` exposes no test seam for roots, instead unit-test the exported helper. Add `export` to `normalizeRootsOption` temporarily is NOT allowed (keeps API stable) — instead write the test against a tiny extracted pure helper. See Step 3: extract `pathToFileUriBrowserSafe`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/roots.test.ts`
Expected: existing roots tests PASS; new test PASS once helper exists.

- [ ] **Step 3: Implement** — in `src/client/client.ts`:

Remove top-level `import { resolve } from 'node:path'` and `import { pathToFileURL } from 'node:url'` (lines 1-2).

Make normalization async + lazy. Replace the three functions:
```ts
function normalizeRootsOption(roots: RootsValue): () => Promise<Root[]> {
  if (typeof roots === 'function') {
    return async () => Promise.all((await roots()).map(normalizeRootInput))
  }
  return async () => Promise.all(roots.map(normalizeRootInput))
}

async function normalizeRootInput(input: RootInput): Promise<Root> {
  if (typeof input === 'string') return { uri: await normalizeRootUri(input) }
  return { ...input, uri: await normalizeRootUri(input.uri) }
}

async function normalizeRootUri(input: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input // already a URI (file://, http://, ...)
  // Relative/absolute filesystem path → requires Node.
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error(
      `Cannot normalize filesystem root "${input}" in a browser. Pass a file:// URI instead.`,
    )
  }
  const { resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  return pathToFileURL(resolve(input)).href
}
```

Confirm the only caller of `normalizeRootsOption` already `await`s the returned callback (it returns `() => Promise<Root[]>`, which the SDK roots/list handler awaits — unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/client/roots.test.ts tests/client/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/client.ts tests/client/roots.test.ts
git commit -m "refactor(client): make root URI normalization browser-safe with lazy node imports"
```

---

## Task 5: Add `"browser"` package field + bundle smoke test (Phase A gate)

**Files:**
- Modify: `package.json`
- Create: `scripts/test-browser-bundle.mjs`
- Modify: `package.json` scripts (`test:browser-bundle`, hook into `prepublishOnly`)

**Interfaces:**
- Produces: `npm run test:browser-bundle` — exits non-zero if any Node built-in appears in the browser bundle of `src/client/index.ts`.

- [ ] **Step 1: Add esbuild devDependency**

Run: `npm install -D esbuild`
Expected: `esbuild` added to `devDependencies`.

- [ ] **Step 2: Write the smoke test** — create `scripts/test-browser-bundle.mjs`:

```js
import { build } from 'esbuild'

const FORBIDDEN = ['child_process', 'fs/promises', 'node:fs', 'fs', 'http', 'https', 'os', 'node:path', 'node:url', 'net', 'tls', '@modelcontextprotocol/sdk/client/stdio.js']

const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  // Node built-ins must resolve to empty (mirrors the package.json "browser" map).
  external: [],
})

const out = result.outputFiles.map((f) => f.text).join('\n')
const leaked = FORBIDDEN.filter((m) => out.includes(`require("${m}")`) || out.includes(`from"${m}"`) || out.includes(`import"${m}"`))

if (leaked.length) {
  console.error('Browser bundle leaked Node built-ins:', leaked)
  process.exit(1)
}
console.log('OK: browser bundle is free of Node built-ins')
```

> NOTE: dynamic `import('child_process')` is code-split by esbuild into a separate chunk that is only fetched at runtime; with `platform: 'browser'` + the `"browser"` map, those specifiers resolve to empty stubs. If the build itself throws "Could not resolve", that is also a failure to fix (add the specifier to the `"browser"` map below).

- [ ] **Step 3: Add the `"browser"` map + scripts to `package.json`**

Add a top-level `"browser"` field:
```json
  "browser": {
    "child_process": false,
    "fs": false,
    "fs/promises": false,
    "http": false,
    "https": false,
    "os": false,
    "net": false,
    "tls": false
  },
  "sideEffects": false,
```
Add to `"scripts"`:
```json
    "test:browser-bundle": "node scripts/test-browser-bundle.mjs",
```
Update `"prepublishOnly"` to:
```json
    "prepublishOnly": "npm run build && node scripts/test-dist.mjs && npm run test:browser-bundle",
```

- [ ] **Step 4: Run the smoke test**

Run: `npm run test:browser-bundle`
Expected: `OK: browser bundle is free of Node built-ins`. If it fails, the offending module came in via a static import — trace and convert it to dynamic (Tasks 1-4 cover the known ones).

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/test-browser-bundle.mjs package-lock.json
git commit -m "test(client): add browser bundle smoke test + package browser field"
```

---

## Task 6: Split `auth.ts` into a focused `auth/` module

**Files:**
- Create: `src/client/auth/stores.ts`, `src/client/auth/file-storage.ts`, `src/client/auth/oauth.ts`, `src/client/auth/bearer.ts`, `src/client/auth/client-credentials.ts`, `src/client/auth/index.ts`
- Delete: `src/client/auth.ts`
- Modify: imports in `src/client/client.ts`, `src/client/transports.ts`, `src/client/index.ts` (change `'./auth.js'` → `'./auth/index.js'`)
- Test: existing `tests/client/auth.test.ts` (update import path to `'../../src/client/auth/index.js'`)

**Interfaces:**
- Produces: `src/client/auth/index.ts` re-exporting exactly the current public symbols: `OAuthToken`, `KeyValueStore`, `InMemoryStore`, `FileTokenStorage`, `OAuth`, `OAuthOptions`, `BearerAuth`, `ClientCredentials`, `ClientCredentialsOptions`. No behavior change.

- [ ] **Step 1: Move code into modules** (pure move — no logic change):
  - `stores.ts`: `KeyValueStore` type + `InMemoryStore`.
  - `file-storage.ts`: `FileTokenStorage` (imports `KeyValueStore` from `./stores.js`).
  - `oauth.ts`: `OAuthToken`, `OAuthOptions`, `OAuth`, and the module-local `openBrowser` helper (imports `KeyValueStore`, `InMemoryStore` from `./stores.js`).
  - `bearer.ts`: `BearerAuth`.
  - `client-credentials.ts`: `ClientCredentials`, `ClientCredentialsOptions`, `normalizeToken`, `isExpiring`, `DEFAULT_REFRESH_BUFFER_SECONDS` (imports from `./stores.js`).
  - `index.ts`: re-export all public symbols above.

- [ ] **Step 2: Update import paths** in `client.ts`, `transports.ts`, `index.ts` from `'./auth.js'` to `'./auth/index.js'`, and in `tests/client/auth.test.ts` to `'../../src/client/auth/index.js'`. Delete `src/client/auth.ts`.

- [ ] **Step 3: Run the full suite + smoke test + typecheck**

Run: `npm run typecheck && npm test && npm run test:browser-bundle`
Expected: all PASS (no behavioral change).

- [ ] **Step 4: Commit**

```bash
git add -A src/client/auth src/client/auth.ts src/client/client.ts src/client/transports.ts src/client/index.ts tests/client/auth.test.ts
git commit -m "refactor(client): split auth.ts into focused auth/ modules"
```

---

## Task 7: Browser key-value stores (`IndexedDBStore`, `LocalStorageStore`)

**Files:**
- Create: `src/client/auth/browser-stores.ts`
- Modify: `src/client/auth/index.ts` (export new stores)
- Test: `tests/client/stores.test.ts`

**Interfaces:**
- Produces:
  - `class LocalStorageStore implements KeyValueStore` — ctor `(prefix = 'fastmcp:')`.
  - `class IndexedDBStore implements KeyValueStore` — ctor `(opts?: { dbName?: string; storeName?: string })`, defaults `dbName: 'fastmcp'`, `storeName: 'auth'`.
- Consumes: `KeyValueStore` from `./stores.js`.

- [ ] **Step 1: Write the failing test** — create `tests/client/stores.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { LocalStorageStore, IndexedDBStore } from '../../src/client/auth/index.js'

describe('LocalStorageStore', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips and deletes with a namespaced prefix', async () => {
    const s = new LocalStorageStore('t:')
    await s.set('a', '1')
    expect(await s.get('a')).toBe('1')
    expect(localStorage.getItem('t:a')).toBe('1')
    await s.delete('a')
    expect(await s.get('a')).toBeNull()
  })
})

describe('IndexedDBStore', () => {
  it('round-trips and deletes', async () => {
    const s = new IndexedDBStore({ dbName: 'test-db' })
    await s.set('k', 'v')
    expect(await s.get('k')).toBe('v')
    await s.delete('k')
    expect(await s.get('k')).toBeNull()
  })
})
```

- [ ] **Step 2: Add jsdom + fake-indexeddb devDeps**

Run: `npm install -D jsdom fake-indexeddb`
Expected: both in `devDependencies`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/client/stores.test.ts`
Expected: FAIL — `LocalStorageStore`/`IndexedDBStore` not exported.

- [ ] **Step 4: Implement** — create `src/client/auth/browser-stores.ts`:

```ts
import type { KeyValueStore } from './stores.js'

export class LocalStorageStore implements KeyValueStore {
  private readonly _prefix: string
  constructor(prefix = 'fastmcp:') {
    this._prefix = prefix
  }
  async get(key: string): Promise<string | null> {
    return localStorage.getItem(this._prefix + key)
  }
  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(this._prefix + key, value)
  }
  async delete(key: string): Promise<void> {
    localStorage.removeItem(this._prefix + key)
  }
}

export class IndexedDBStore implements KeyValueStore {
  private readonly _dbName: string
  private readonly _storeName: string
  constructor(opts: { dbName?: string; storeName?: string } = {}) {
    this._dbName = opts.dbName ?? 'fastmcp'
    this._storeName = opts.storeName ?? 'auth'
  }
  private _open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(this._storeName)) {
          req.result.createObjectStore(this._storeName)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
    })
  }
  private async _tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this._open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(this._storeName, mode).objectStore(this._storeName))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'))
      })
    } finally {
      db.close()
    }
  }
  async get(key: string): Promise<string | null> {
    const v = await this._tx<string | undefined>('readonly', (s) => s.get(key))
    return v ?? null
  }
  async set(key: string, value: string): Promise<void> {
    await this._tx('readwrite', (s) => s.put(value, key))
  }
  async delete(key: string): Promise<void> {
    await this._tx('readwrite', (s) => s.delete(key))
  }
}
```

Add to `src/client/auth/index.ts`:
```ts
export { LocalStorageStore, IndexedDBStore } from './browser-stores.js'
```

- [ ] **Step 5: Run tests + smoke test to verify they pass**

Run: `npx vitest run tests/client/stores.test.ts && npm run test:browser-bundle`
Expected: PASS (the browser-only globals are referenced inside methods, so the bundle stays clean and Node import doesn't crash).

- [ ] **Step 6: Commit**

```bash
git add src/client/auth/browser-stores.ts src/client/auth/index.ts tests/client/stores.test.ts package.json package-lock.json
git commit -m "feat(client): add LocalStorageStore and IndexedDBStore browser token stores"
```

---

## Task 8: `BrowserOAuth` popup flow + `handleOAuthCallback`

**Files:**
- Create: `src/client/auth/browser-oauth.ts`
- Modify: `src/client/auth/index.ts` (export `BrowserOAuth`, `BrowserOAuthOptions`, `handleOAuthCallback`)
- Test: `tests/client/browser-oauth.test.ts`

**Interfaces:**
- Consumes: `OAuth`, `OAuthOptions` from `./oauth.js`.
- Produces:
  - `interface BrowserOAuthOptions extends Omit<OAuthOptions, 'callbackPort' | 'onRedirect'>` adding `redirectUri: string`, `mode?: 'popup' | 'redirect'` (default `'popup'`), `popupFeatures?: string`.
  - `class BrowserOAuth extends OAuth` — overrides `redirectUrl`, `clientMetadata`, `redirectToAuthorization`, `waitForCallback`. So `client.ts`'s `instanceof OAuth` branch drives it unchanged.
  - `function handleOAuthCallback(opts?: { targetOrigin?: string }): void` — called by the app's redirect page; posts `{ type: 'fastmcp:oauth', code?, error? }` to `window.opener` and closes.

- [ ] **Step 1: Write the failing test** — create `tests/client/browser-oauth.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { BrowserOAuth, OAuth } from '../../src/client/auth/index.js'

describe('BrowserOAuth popup flow', () => {
  it('is an instanceof OAuth (so the client flow drives it)', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    expect(o).toBeInstanceOf(OAuth)
  })

  it('uses the app redirectUri in metadata', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    expect(o.redirectUrl).toBe('https://app.example/callback')
    expect(o.clientMetadata.redirect_uris).toEqual(['https://app.example/callback'])
  })

  it('opens a popup and resolves waitForCallback from a postMessage', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    const popup = { closed: false, close: vi.fn() }
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    await o.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'))
    expect(openSpy).toHaveBeenCalledOnce()

    const wait = o.waitForCallback(5000)
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://app.example',
      data: { type: 'fastmcp:oauth', code: 'THE_CODE' },
    }))
    expect(await wait).toBe('THE_CODE')
    expect(popup.close).toHaveBeenCalled()
  })

  it('rejects waitForCallback on an error message', async () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback' })
    o._bind('https://srv.example')
    vi.spyOn(window, 'open').mockReturnValue({ closed: false, close: vi.fn() } as unknown as Window)
    await o.redirectToAuthorization(new URL('https://auth.example/authorize'))
    const wait = o.waitForCallback(5000)
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://app.example',
      data: { type: 'fastmcp:oauth', error: 'access_denied' },
    }))
    await expect(wait).rejects.toThrow(/access_denied/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/browser-oauth.test.ts`
Expected: FAIL — `BrowserOAuth` not exported.

- [ ] **Step 3: Implement** — create `src/client/auth/browser-oauth.ts`:

```ts
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { OAuth, type OAuthOptions } from './oauth.js'

const MESSAGE_TYPE = 'fastmcp:oauth'

export interface BrowserOAuthOptions
  extends Omit<OAuthOptions, 'callbackPort' | 'onRedirect'> {
  /** Redirect URI registered with the provider; must serve a page that calls handleOAuthCallback(). */
  redirectUri: string
  /** 'popup' (default) opens a window and listens for postMessage; 'redirect' navigates the tab. */
  mode?: 'popup' | 'redirect'
  /** window.open features string for popup mode. */
  popupFeatures?: string
}

export class BrowserOAuth extends OAuth {
  private readonly _redirectUri: string
  private readonly _mode: 'popup' | 'redirect'
  private readonly _popupFeatures: string
  private _popup: Window | null = null
  private _messageHandler: ((e: MessageEvent) => void) | null = null

  constructor(options: BrowserOAuthOptions) {
    super(options)
    this._redirectUri = options.redirectUri
    this._mode = options.mode ?? 'popup'
    this._popupFeatures = options.popupFeatures ?? 'width=600,height=720'
  }

  get redirectUrl(): string {
    return this._redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    return { ...super.clientMetadata, redirect_uris: [this._redirectUri] }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this._mode === 'redirect') {
      window.location.href = authorizationUrl.toString()
      return // navigation destroys this context; resume via resumeFromRedirect (Task 9)
    }
    const expectedOrigin = new URL(this._redirectUri).origin
    // Arm the callback promise BEFORE opening so a fast provider can't race us.
    this._messageHandler = (e: MessageEvent) => {
      if (e.origin !== expectedOrigin) return
      const data = e.data as { type?: string; code?: string; error?: string }
      if (data?.type !== MESSAGE_TYPE) return
      if (data.error) this._rejectCallback(new Error(`OAuth authorization denied: ${data.error}`))
      else if (data.code) this._resolveCallback(data.code)
    }
    window.addEventListener('message', this._messageHandler)
    this._armCallbackPromise()
    this._popup = window.open(authorizationUrl.toString(), 'fastmcp-oauth', this._popupFeatures)
    if (!this._popup) {
      this._teardown()
      throw new Error('Failed to open OAuth popup — it was likely blocked. Trigger connect from a user gesture or use mode: "redirect".')
    }
  }

  async waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<string> {
    try {
      return await this._awaitCallback(timeoutMs)
    } finally {
      this._teardown()
    }
  }

  private _teardown(): void {
    if (this._messageHandler) window.removeEventListener('message', this._messageHandler)
    this._messageHandler = null
    try { this._popup?.close() } catch { /* cross-origin close may throw */ }
    this._popup = null
  }
}

/** Call from the redirect_uri page to deliver the code back to the opener and close. */
export function handleOAuthCallback(opts: { targetOrigin?: string } = {}): void {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code') ?? undefined
  const error = params.get('error_description') ?? params.get('error') ?? undefined
  const target = opts.targetOrigin ?? window.location.origin
  window.opener?.postMessage({ type: MESSAGE_TYPE, code, error }, target)
  window.close()
}
```

This requires three small protected hooks on the base `OAuth` class. In `src/client/auth/oauth.ts`, add:
```ts
  protected _armCallbackPromise(): void {
    this._callbackPromise = new Promise<string>((resolve, reject) => {
      this._callbackResolve = resolve
      this._callbackReject = reject
    })
    this._callbackPromise.catch(() => {})
  }
  protected _resolveCallback(code: string): void { this._callbackResolve?.(code) }
  protected _rejectCallback(err: Error): void { this._callbackReject?.(err) }
  protected async _awaitCallback(timeoutMs: number): Promise<string> {
    if (!this._callbackPromise) throw new Error('No pending OAuth callback — call redirectToAuthorization() first')
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('OAuth callback timed out waiting for authorization')), timeoutMs))
    try { return await Promise.race([this._callbackPromise, timeout]) }
    finally { this._callbackPromise = null; this._callbackResolve = null; this._callbackReject = null }
  }
```
Change the base `_callbackPromise`/`_callbackResolve`/`_callbackReject` fields from `private` to `protected`, and refactor the base `redirectToAuthorization`/`waitForCallback` to call `_armCallbackPromise()`/`_awaitCallback()` (then `_stopCallbackServer()` in its `finally`) so logic is shared, not duplicated.

Add to `src/client/auth/index.ts`:
```ts
export { BrowserOAuth, handleOAuthCallback } from './browser-oauth.js'
export type { BrowserOAuthOptions } from './browser-oauth.js'
```

- [ ] **Step 4: Run tests + node auth tests + smoke test**

Run: `npx vitest run tests/client/browser-oauth.test.ts tests/client/auth.test.ts && npm run test:browser-bundle`
Expected: PASS (the base refactor must keep the Node OAuth tests green).

- [ ] **Step 5: Commit**

```bash
git add src/client/auth/browser-oauth.ts src/client/auth/oauth.ts src/client/auth/index.ts tests/client/browser-oauth.test.ts
git commit -m "feat(client): add BrowserOAuth popup flow and handleOAuthCallback"
```

---

## Task 9: `BrowserOAuth` redirect mode + `resumeFromRedirect`

**Files:**
- Modify: `src/client/auth/browser-oauth.ts`
- Test: `tests/client/browser-oauth.test.ts`

**Interfaces:**
- Produces: `BrowserOAuth.resumeFromRedirect(href = window.location.href): string | null` — parses `?code=`/`?error=` from a returned URL and returns the code (or null). The app, after the tab navigates back, calls this to get the code and feeds it to the connect/`finishAuth` retry. Throws on `error`.

- [ ] **Step 1: Write the failing test** — add to `tests/client/browser-oauth.test.ts`:

```ts
describe('BrowserOAuth redirect mode', () => {
  it('resumeFromRedirect extracts the code from a returned URL', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode: 'redirect' })
    expect(o.resumeFromRedirect('https://app.example/callback?code=XYZ&state=s')).toBe('XYZ')
  })
  it('resumeFromRedirect returns null when there is no code', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode: 'redirect' })
    expect(o.resumeFromRedirect('https://app.example/callback')).toBeNull()
  })
  it('resumeFromRedirect throws on an error param', () => {
    const o = new BrowserOAuth({ redirectUri: 'https://app.example/callback', mode: 'redirect' })
    expect(() => o.resumeFromRedirect('https://app.example/callback?error=access_denied'))
      .toThrow(/access_denied/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/browser-oauth.test.ts -t "redirect mode"`
Expected: FAIL — `resumeFromRedirect` not a function.

- [ ] **Step 3: Implement** — add to `BrowserOAuth`:

```ts
  resumeFromRedirect(href: string = window.location.href): string | null {
    const params = new URL(href).searchParams
    const error = params.get('error_description') ?? params.get('error')
    if (error) throw new Error(`OAuth authorization denied: ${error}`)
    return params.get('code')
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/browser-oauth.test.ts`
Expected: PASS (all popup + redirect cases).

- [ ] **Step 5: Commit**

```bash
git add src/client/auth/browser-oauth.ts tests/client/browser-oauth.test.ts
git commit -m "feat(client): add BrowserOAuth redirect mode resumeFromRedirect"
```

---

## Task 10: Re-export browser symbols from `src/client/index.ts`

**Files:**
- Modify: `src/client/index.ts`
- Test: `tests/client/exports.test.ts`

**Interfaces:**
- Produces: `fastmcp/client` exports `IndexedDBStore`, `LocalStorageStore`, `BrowserOAuth`, `handleOAuthCallback`, and type `BrowserOAuthOptions`, alongside the existing auth exports.

- [ ] **Step 1: Write the failing test** — create `tests/client/exports.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as client from '../../src/client/index.js'

describe('client public exports', () => {
  it('exposes browser auth primitives', () => {
    expect(typeof client.BrowserOAuth).toBe('function')
    expect(typeof client.IndexedDBStore).toBe('function')
    expect(typeof client.LocalStorageStore).toBe('function')
    expect(typeof client.handleOAuthCallback).toBe('function')
  })
  it('still exposes existing symbols', () => {
    expect(typeof client.Client).toBe('function')
    expect(typeof client.OAuth).toBe('function')
    expect(typeof client.BearerAuth).toBe('function')
    expect(typeof client.FileTokenStorage).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/exports.test.ts`
Expected: FAIL — browser primitives undefined.

- [ ] **Step 3: Implement** — in `src/client/index.ts`, extend the auth export block:

```ts
export type {
  OAuthToken,
  KeyValueStore,
  OAuthOptions,
  ClientCredentialsOptions,
  BrowserOAuthOptions,
} from './auth/index.js'
export {
  OAuth, BearerAuth, ClientCredentials, InMemoryStore, FileTokenStorage,
  BrowserOAuth, handleOAuthCallback, IndexedDBStore, LocalStorageStore,
} from './auth/index.js'
```
(Replace the existing `from './auth.js'` lines — Task 6 already pointed these at `./auth/index.js`.)

- [ ] **Step 4: Run tests + typecheck + smoke test**

Run: `npm run typecheck && npx vitest run tests/client/exports.test.ts && npm run test:browser-bundle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/index.ts tests/client/exports.test.ts
git commit -m "feat(client): export browser auth primitives from fastmcp/client"
```

---

## Task 11: Playwright e2e — real popup OAuth in Chromium

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/browser/oauth-e2e.spec.ts`
- Create: `tests/browser/fixtures/mock-server.mjs` (mock MCP Streamable HTTP + OAuth endpoints + callback page)
- Modify: `package.json` (devDep `@playwright/test`, script `test:e2e`)

**Interfaces:**
- Consumes: the built browser bundle of `fastmcp/client` (bundled on the fly by the test via esbuild) + the mock server.
- Produces: `npm run test:e2e` — drives a popup OAuth dance end-to-end and asserts a `listTools()` call succeeds in Chromium.

- [ ] **Step 1: Add Playwright**

Run: `npm install -D @playwright/test && npx playwright install chromium`
Expected: dep added; Chromium downloaded.

- [ ] **Step 2: Write the mock server** — create `tests/browser/fixtures/mock-server.mjs`:

```js
import { createServer } from 'http'
import { build } from 'esbuild'

// Minimal mock: serves the app page, a bundled client, an OAuth authorize+token endpoint,
// the callback page, and a Streamable HTTP MCP endpoint that requires a Bearer token.
export async function startMockServer(port = 0) {
  const bundle = await build({
    entryPoints: ['tests/browser/fixtures/app-entry.mjs'],
    bundle: true, platform: 'browser', format: 'esm', write: false,
  })
  const appJs = bundle.outputFiles[0].text
  const ACCESS = 'mock-access-token'

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`)
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(`<!doctype html><button id="connect">Connect</button><pre id="out"></pre><script type="module">${appJs}</script>`)
    }
    if (url.pathname === '/callback') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(`<script type="module">import { handleOAuthCallback } from '/client.js'; handleOAuthCallback()</script>`)
    }
    if (url.pathname === '/authorize') {
      // Immediately redirect back with a code (no real login UI).
      const redirect = url.searchParams.get('redirect_uri')
      res.writeHead(302, { location: `${redirect}?code=mock-code` })
      return res.end()
    }
    if (url.pathname === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ access_token: ACCESS, token_type: 'Bearer', expires_in: 3600 }))
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        issuer: `http://localhost:${server.address().port}`,
        authorization_endpoint: `http://localhost:${server.address().port}/authorize`,
        token_endpoint: `http://localhost:${server.address().port}/token`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
      }))
    }
    if (url.pathname === '/mcp') {
      // Assert auth then return a minimal JSON-RPC initialize/tools response.
      if (req.headers.authorization !== `Bearer ${ACCESS}`) { res.writeHead(401); return res.end() }
      // ... minimal MCP Streamable HTTP handshake; see app-entry.mjs for the client calls.
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{}')
    }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => server.listen(port, r))
  return { server, port: server.address().port }
}
```

> IMPLEMENTER NOTE: a faithful Streamable HTTP MCP mock is involved. Prefer reusing the project's existing in-test server harness from `tests/client/*.test.ts` (they already stand up real FastMCP servers over HTTP). If an existing helper can serve over a real port with an injected OAuth requirement, drive the e2e against that instead of hand-rolling `/mcp`. The OAuth endpoints above still apply.

- [ ] **Step 3: Write the app entry** — create `tests/browser/fixtures/app-entry.mjs`:

```js
import { Client, BrowserOAuth, IndexedDBStore } from '/client.js'

document.getElementById('connect').addEventListener('click', async () => {
  const out = document.getElementById('out')
  try {
    const base = location.origin
    const client = new Client(`${base}/mcp`, {
      auth: new BrowserOAuth({ redirectUri: `${base}/callback`, store: new IndexedDBStore() }),
    })
    await client.connect()
    const tools = await client.listTools()
    out.textContent = 'OK:' + tools.length
  } catch (e) {
    out.textContent = 'ERR:' + (e instanceof Error ? e.message : String(e))
  }
})
```

(The mock server must also serve `/client.js` as the esbuild-bundled `src/client/index.ts`.)

- [ ] **Step 4: Write the Playwright config + test** — create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'tests/browser',
  use: { headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
```

Create `tests/browser/oauth-e2e.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { startMockServer } from './fixtures/mock-server.mjs'

test('completes popup OAuth and lists tools', async ({ page, context }) => {
  const { server, port } = await startMockServer()
  try {
    await page.goto(`http://localhost:${port}/`)
    const popupPromise = context.waitForEvent('page') // the OAuth popup
    await page.click('#connect')
    const popup = await popupPromise
    await popup.waitForEvent('close') // callback page posts code then closes
    await expect(page.locator('#out')).toHaveText(/^OK:/, { timeout: 15000 })
  } finally {
    server.close()
  }
})
```

Add to `package.json` scripts: `"test:e2e": "playwright test"`.

- [ ] **Step 5: Run the e2e**

Run: `npm run test:e2e`
Expected: 1 passed — `#out` shows `OK:<n>`.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts tests/browser package.json package-lock.json
git commit -m "test(client): add Playwright e2e for in-browser popup OAuth + tool call"
```

---

## Self-Review

**Spec coverage:**
- Single browser-safe entry via lazy imports → Tasks 1-4. ✓
- `"browser"` package field + no-Node-builtin guarantee → Task 5 (smoke test gates it). ✓
- Bearer + browser KeyValueStore → Task 7 (Bearer already browser-safe; verified bundling in Task 5). ✓
- Full browser OAuth, popup default + redirect mode → Tasks 8-9. ✓
- jsdom units → Tasks 7-9; bundle smoke test → Task 5; Playwright e2e → Task 11. ✓
- Node parity preserved → enforced by keeping `tests/client/*` green every task (Tasks 1-3, 6, 8 explicitly re-run them). ✓
- auth.ts module split → Task 6. ✓

**Placeholder scan:** Two `IMPLEMENTER NOTE`s in Task 11 point at reusing the existing test-server harness for the MCP mock rather than hand-rolling a full Streamable HTTP server — this is a genuine "prefer existing infra" pointer, not a deferred requirement; the OAuth flow itself is fully specified. No `TBD`/`TODO` elsewhere.

**Type consistency:** `KeyValueStore` shared across stores and OAuth options; `BrowserOAuth extends OAuth` and relies on `protected` `_callbackPromise`/`_callbackResolve`/`_callbackReject` + `_armCallbackPromise`/`_resolveCallback`/`_rejectCallback`/`_awaitCallback` added to the base in Task 8 — names match between base and subclass. `resolveTransport`/`resolveEntryTransport` async signatures consistent across Tasks 1 callers. `handleOAuthCallback` message shape `{ type: 'fastmcp:oauth', code?, error? }` matches the popup listener in Task 8.
