import { defineCommand } from 'citty'

export default defineCommand({
  meta: { name: 'install', description: 'Install an MCP server into a client config' },
  subCommands: {
    'claude-code': () => import('./claude-code.js').then((m) => m.default),
    'claude-desktop': () => import('./claude-desktop.js').then((m) => m.default),
    cursor: () => import('./cursor.js').then((m) => m.default),
    gemini: () => import('./gemini.js').then((m) => m.default),
    goose: () => import('./goose.js').then((m) => m.default),
    'mcp-json': () => import('./mcp-json.js').then((m) => m.default),
  },
})
