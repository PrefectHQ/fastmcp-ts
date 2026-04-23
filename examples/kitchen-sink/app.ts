import {
  FastMCPApp,
  Column, Row,
  Text, Badge, Table, Button, Input,
} from 'fastmcp-ts/server'
import { notes, nextId } from './store.js'

export const notesApp = new FastMCPApp({ name: 'notes-ui', version: '1.0.0' })

// ── Entrypoint ────────────────────────────────────────────────────────────────
// Visible to the LLM and linked to a ui:// resource. Returns a component tree
// that the MCP host renders as an interactive UI.

notesApp.entrypoint(
  {
    name: 'notes_dashboard',
    description: 'Open the interactive Dev Notes Hub dashboard.',
  },
  () =>
    Column({}, [
      Text('Dev Notes Hub', { variant: 'heading' }),
      Row({ gap: 8 }, [
        Badge(`${notes.size} notes`, { color: 'blue' }),
        Badge('kitchen-sink demo', { color: 'green' }),
      ]),
      Button({
        label: 'Refresh notes',
        action: notesApp.toolRef('fetch_notes_table'),
        variant: 'secondary',
      }),
      Row({ gap: 8 }, [
        Input({ name: 'title',   label: 'Title',   type: 'text', placeholder: 'Note title',   required: true }),
        Input({ name: 'content', label: 'Content', type: 'text', placeholder: 'Note content' }),
        Input({ name: 'tags',    label: 'Tags',    type: 'text', placeholder: 'tasks, meta, …' }),
      ]),
      Button({ label: 'Add note', action: notesApp.toolRef('submit_note') }),
    ]),
)

// ── Backend tools ─────────────────────────────────────────────────────────────
// Hidden from the LLM (visibility: ['app']). Called only from UI button actions.

notesApp.server.tool(
  {
    name: 'fetch_notes_table',
    description: 'Return all notes as a rendered table component.',
    ui: { visibility: ['app'] },
  },
  () =>
    Table({
      columns: ['ID', 'Title', 'Tags', 'Created'],
      rows: [...notes.values()].map((n) => [
        n.id,
        n.title,
        n.tags.join(', '),
        n.createdAt.slice(0, 10),
      ]),
    }),
)

notesApp.server.tool(
  {
    name: 'submit_note',
    description: 'Handle the add-note form submission from the dashboard.',
    ui: { visibility: ['app'] },
  },
  ({ title, content, tags }: { title?: string; content?: string; tags?: string }) => {
    if (!title?.trim()) return Text('Title is required.', { color: 'red' })
    const id = nextId()
    const tagList = tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : []
    notes.set(id, {
      id,
      title: title.trim(),
      content: content ?? '',
      tags: tagList,
      createdAt: new Date().toISOString(),
    })
    return Column({}, [
      Badge('Note added!', { color: 'green' }),
      Text(`Created "${title.trim()}" with ID ${id}.`),
    ])
  },
)
