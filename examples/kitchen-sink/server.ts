import {
  FastMCP,
  staticTokenVerifier,
  requireScopes,
  LoggingMiddleware,
  CachingMiddleware,
} from 'fastmcp-ts/server'
import { z } from 'zod'
import { notes, nextId } from './store.js'
import { notesApp } from './app.js'

// ── Auth ──────────────────────────────────────────────────────────────────────
// Three tokens with escalating scopes.
// read-token  → read
// write-token → read + write
// admin-token → read + write + admin

const auth = staticTokenVerifier({
  'read-token':  { clientId: 'reader', scopes: ['read'] },
  'write-token': { clientId: 'writer', scopes: ['read', 'write'] },
  'admin-token': { clientId: 'admin',  scopes: ['read', 'write', 'admin'] },
})

// ── Server ────────────────────────────────────────────────────────────────────

const server = new FastMCP({
  name: 'kitchen-sink',
  version: '1.0.0',
  auth,
  middleware: [
    new LoggingMiddleware(),
    new CachingMiddleware(5_000),
  ],
})

// Mount the UI app under the 'ui' namespace.
// All app tools become ui_notes_dashboard, ui_fetch_notes_table, etc.
server.mount(notesApp.server, 'ui')

// ── Tools ─────────────────────────────────────────────────────────────────────

server.tool(
  {
    name: 'get_time',
    description: 'Return the current UTC time. No auth required.',
  },
  async () => {
    const ctx = server.getContext()
    await ctx.info('get_time called')
    return new Date().toUTCString()
  },
)

server.tool(
  {
    name: 'add_note',
    description: 'Add a new note to the hub.',
    input: z.object({
      title:   z.string().min(1).describe('Note title'),
      content: z.string().describe('Note body text'),
      tags:    z.array(z.string()).optional().describe('Optional tags'),
    }),
    auth: requireScopes('write'),
  },
  async ({ title, content, tags = [] }) => {
    const ctx = server.getContext()
    const id = nextId()
    const note = { id, title, content, tags, createdAt: new Date().toISOString() }
    notes.set(id, note)
    await ctx.info(`Added note ${id}: "${title}"`)
    return note
  },
)

server.tool(
  {
    name: 'get_note',
    description: 'Retrieve a single note by ID.',
    input: z.object({
      id: z.string().describe('Note ID'),
    }),
    auth: requireScopes('read'),
  },
  async ({ id }) => {
    const ctx = server.getContext()
    const note = notes.get(id)
    if (!note) {
      await ctx.warning(`Note ${id} not found`)
      throw new Error(`Note "${id}" not found`)
    }
    return note
  },
)

server.tool(
  {
    name: 'list_notes',
    description: 'List all notes, optionally filtered by tag.',
    input: z.object({
      tag: z.string().optional().describe('Filter by tag'),
    }),
    auth: requireScopes('read'),
  },
  async ({ tag }) => {
    const ctx = server.getContext()
    const all = [...notes.values()]
    await ctx.reportProgress(0, all.length, 'scanning notes')
    const filtered = tag ? all.filter((n) => n.tags.includes(tag)) : all
    for (let i = 0; i < filtered.length; i++) {
      await ctx.reportProgress(i + 1, filtered.length, filtered[i].title)
    }
    await ctx.info(`list_notes → ${filtered.length} note(s)`)
    return filtered
  },
)

server.tool(
  {
    name: 'delete_note',
    description: 'Permanently delete a note. Requires the admin scope.',
    input: z.object({
      id: z.string().describe('Note ID to delete'),
    }),
    auth: requireScopes('admin'),
  },
  async ({ id }) => {
    const ctx = server.getContext()
    if (!notes.has(id)) throw new Error(`Note "${id}" not found`)
    notes.delete(id)
    await ctx.info(`Deleted note ${id}`)
    return `Note ${id} deleted.`
  },
)

server.tool(
  {
    name: 'analyze_notes',
    description:
      'Ask the LLM (via sampling) to analyze all notes. Requires a sampling-capable client.',
    input: z.object({
      style: z.enum(['brief', 'detailed']).describe('Summary style'),
    }),
    auth: requireScopes('write'),
  },
  async ({ style }) => {
    const ctx = server.getContext()
    const all = [...notes.values()]

    await ctx.reportProgress(0, 3, 'gathering notes')
    const noteList = all
      .map((n) => `[${n.id}] ${n.title} (tags: ${n.tags.join(', ')})\n${n.content}`)
      .join('\n\n')

    await ctx.reportProgress(1, 3, 'sending to LLM')
    const result = await ctx.sample({
      systemPrompt: 'You are a helpful assistant that analyzes personal notes.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Summarize the following notes in a ${style} style:\n\n${noteList}`,
          },
        },
      ],
      maxTokens: 512,
    })

    await ctx.reportProgress(3, 3, 'done')
    await ctx.info('analyze_notes completed')
    return result.content.type === 'text' ? result.content.text : '[non-text response]'
  },
)

// ── Resources ─────────────────────────────────────────────────────────────────

server.resource(
  {
    name: 'all-notes',
    uri: 'notes://all',
    description: 'All notes as a JSON array.',
    mimeType: 'application/json',
    annotations: { audience: ['assistant', 'user'], priority: 0.8 },
    auth: requireScopes('read'),
  },
  () => JSON.stringify([...notes.values()], null, 2),
)

server.resource(
  {
    name: 'note-by-id',
    uri: 'notes://{id}',
    description: 'A single note by its ID.',
    mimeType: 'application/json',
    auth: requireScopes('read'),
  },
  (params) => {
    const id = params?.id ?? ''
    const note = notes.get(id)
    if (!note) throw new Error(`Note "${id}" not found`)
    return JSON.stringify(note, null, 2)
  },
)

server.resource(
  {
    name: 'settings',
    uri: 'config://settings',
    description: 'Server metadata and feature list.',
    mimeType: 'application/json',
  },
  () =>
    JSON.stringify(
      {
        name: server.name,
        version: server.version,
        features: ['tools', 'resources', 'prompts', 'auth', 'middleware', 'apps'],
      },
      null,
      2,
    ),
)

// ── Prompts ───────────────────────────────────────────────────────────────────

server.prompt(
  {
    name: 'summarize_notes',
    description: 'Build a prompt asking the LLM to summarize all notes.',
    arguments: [
      { name: 'format', description: '"bullet" or "paragraph"', required: true },
    ],
    auth: requireScopes('read'),
  },
  (args) => {
    const format = args?.format ?? 'bullet'
    const list = [...notes.values()]
      .map((n) => `- [${n.id}] ${n.title}: ${n.content}`)
      .join('\n')
    return `Summarize the following notes in ${format} format:\n\n${list}`
  },
)

server.prompt(
  {
    name: 'review_note',
    description: 'Build a constructive review prompt for a specific note.',
    arguments: [
      { name: 'id', description: 'Note ID to review', required: true },
    ],
    auth: requireScopes('read'),
  },
  (args) => {
    const note = notes.get(args?.id ?? '')
    if (!note) throw new Error(`Note "${args?.id}" not found`)
    return (
      `Please review this note and suggest improvements:\n\n` +
      `Title: ${note.title}\n` +
      `Tags: ${note.tags.join(', ')}\n\n` +
      note.content
    )
  },
)

// ── Start ─────────────────────────────────────────────────────────────────────

server.run({ transport: 'http', port: 4010 })
