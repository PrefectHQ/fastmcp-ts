export interface Note {
  id: string
  title: string
  content: string
  tags: string[]
  createdAt: string
}

export const notes = new Map<string, Note>()
let _counter = 0

export function nextId(): string {
  return String(++_counter)
}

// Seed
for (const [title, content, tags] of [
  ['Welcome', 'This is the kitchen-sink demo server.', ['meta']],
  ['TODO', 'Wire up more examples.', ['tasks']],
  ['Ideas', 'Sampling, elicitation, multi-server composition.', ['tasks', 'meta']],
] as [string, string, string[]][]) {
  const id = nextId()
  notes.set(id, { id, title, content, tags, createdAt: new Date().toISOString() })
}
