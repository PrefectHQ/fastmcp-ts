import { defineCommand } from 'citty'

export default defineCommand({
  meta: { name: 'dev', description: 'Development utilities' },
  subCommands: {
    inspector: () => import('./inspector.js').then((m) => m.default),
  },
})
