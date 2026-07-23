/**
 * Kitchen-sink client demo.
 *
 * Start the server first:  npx tsx server.ts
 * Then run this file:      npx tsx client.ts
 *
 * Uses write-token, which has scopes [read, write] but NOT admin.
 * The delete_note call at the end is expected to fail with an auth error.
 */

import { Client, BearerAuth, ToolCallError } from 'fastmcp-ts/client'

const SERVER_URL = 'http://localhost:4010/mcp'

const client = new Client(SERVER_URL, {
  auth: new BearerAuth('write-token'),
  handlers: {
    log: (msg) => console.log(`  [server log] ${msg.level}: ${msg.data}`),
    progress: (progress, total, message) =>
      console.log(`  [progress] ${progress}/${total ?? '?'} — ${message ?? ''}`),
  },
})

await client.connect()

// ── 1. List tools ─────────────────────────────────────────────────────────────

console.log('\n── tools ────────────────────────────────────')
const tools = await client.listTools()
for (const t of tools) console.log(` • ${t.name}: ${t.description}`)

// ── 2. Call get_time (no auth required) ───────────────────────────────────────

console.log('\n── get_time ─────────────────────────────────')
const timeResult = await client.callTool('get_time', {})
console.log(' Result:', extractText(timeResult.content))

// ── 3. Add a note (requires write scope) ─────────────────────────────────────

console.log('\n── add_note ─────────────────────────────────')
const addResult = await client.callTool('add_note', {
  title: 'Client demo',
  content: 'This note was created by the kitchen-sink client script.',
  tags: ['demo', 'client'],
})
console.log(' Result:', extractText(addResult.content))

// ── 4. List notes with progress ───────────────────────────────────────────────

console.log('\n── list_notes ───────────────────────────────')
const listResult = await client.callTool('list_notes', {})
console.log(' Result:', extractText(listResult.content))

// ── 5. Read a static resource ────────────────────────────────────────────────

console.log('\n── resource: notes://all ────────────────────')
const allNotes = await client.readResource('notes://all')
const allNotesText = (allNotes[0] as { text?: string }).text
if (allNotesText) {
  const parsed = JSON.parse(allNotesText) as { id: string; title: string }[]
  console.log(` ${parsed.length} note(s):`, parsed.map((n) => `[${n.id}] ${n.title}`).join(', '))
}

// ── 6. Read a URI template resource ─────────────────────────────────────────

console.log('\n── resource: notes://{id} ───────────────────')
const noteOne = await client.readResource('notes://1')
const noteOneText = (noteOne[0] as { text?: string }).text
if (noteOneText) console.log(' Note 1:', noteOneText)

// ── 7. Read config ────────────────────────────────────────────────────────────

console.log('\n── resource: config://settings ─────────────')
const settings = await client.readResource('config://settings')
const settingsText = (settings[0] as { text?: string }).text
if (settingsText) console.log(' Settings:', settingsText)

// ── 8. List prompts ───────────────────────────────────────────────────────────

console.log('\n── prompts ──────────────────────────────────')
const prompts = await client.listPrompts()
for (const p of prompts) console.log(` • ${p.name}: ${p.description}`)

// ── 9. Get a prompt ───────────────────────────────────────────────────────────

console.log('\n── get_prompt: summarize_notes ──────────────')
const summary = await client.getPrompt('summarize_notes', { format: 'bullet' })
const firstMsg = summary.messages[0]
if (firstMsg?.content.type === 'text') console.log(firstMsg.content.text)

// ── 10. Expected auth failure: delete requires admin scope ────────────────────

console.log('\n── delete_note (expected auth failure) ──────')
try {
  await client.callTool('delete_note', { id: '1' })
  console.log(' Unexpected: delete succeeded!')
} catch (err) {
  const msg = err instanceof ToolCallError ? err.message : String(err)
  console.log(` Auth error as expected: ${msg}`)
}

await client.close()

// ── 11. Version negotiation ───────────────────────────────────────────────────
// fastmcp servers speak both protocol eras (2025 and 2026-07-28) at once.
// `{ mode: 'auto' }` asks a client to use the newest era the server offers.

console.log('\n── version negotiation ──────────────────────')
const modernClient = new Client(SERVER_URL, {
  auth: new BearerAuth('write-token'),
  versionNegotiation: { mode: 'auto' },
})
await modernClient.connect()
console.log(` Negotiated era: ${modernClient.getProtocolEra()}`)
await modernClient.close()

console.log('\nDone.')

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('')
}
