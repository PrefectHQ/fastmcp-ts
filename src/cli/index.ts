import { defineCommand, runMain } from 'citty'
import { setQuiet } from './ui/output.js'
import { setJsonMode } from './ui/format.js'

declare const __FASTMCP_VERSION__: string

const main = defineCommand({
  meta: {
    name: 'fastmcp',
    version: __FASTMCP_VERSION__,
    description: 'FastMCP CLI — build, run, and manage MCP servers',
  },
  args: {
    quiet: { type: 'boolean', description: 'Suppress informational output', default: false },
    json: { type: 'boolean', description: 'Output JSON to stdout', default: false },
  },
  setup({ args }) {
    if (args.quiet) setQuiet(true)
    if (args.json) setJsonMode(true)
  },
  subCommands: {
    version: () => import('./commands/version.js').then((m) => m.default),
    run: () => import('./commands/run.js').then((m) => m.default),
    inspect: () => import('./commands/inspect.js').then((m) => m.default),
    list: () => import('./commands/list.js').then((m) => m.default),
    call: () => import('./commands/call.js').then((m) => m.default),
    discover: () => import('./commands/discover.js').then((m) => m.default),
    install: () => import('./commands/install/index.js').then((m) => m.default),
    dev: () => import('./commands/dev/index.js').then((m) => m.default),
  },
})

runMain(main)
