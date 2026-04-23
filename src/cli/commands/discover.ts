import { defineCommand } from 'citty'
import { output, setJsonMode } from '../ui/format.js'
import { renderTable } from '../ui/table.js'
import { log } from '../ui/output.js'
import { getConfigPaths, readConfig } from '../utils/config-paths.js'

interface DiscoveredServer {
  source: string
  name: string
  transport: string
  target: string
}

function extractServers(source: string, config: unknown): DiscoveredServer[] {
  if (!config || typeof config !== 'object') return []

  const servers: DiscoveredServer[] = []

  // Standard MCP config shape: { mcpServers: { name: { command | url, ... } } }
  const mcpServers = (config as Record<string, unknown>)['mcpServers']
  if (mcpServers && typeof mcpServers === 'object') {
    for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if ('url' in e) {
        servers.push({ source, name, transport: 'http', target: String(e['url']) })
      } else if ('command' in e) {
        const args = Array.isArray(e['args']) ? (e['args'] as string[]).join(' ') : ''
        servers.push({ source, name, transport: 'stdio', target: `${String(e['command'])} ${args}`.trim() })
      }
    }
  }

  // Goose shape: { extensions: { name: { cmd, ... } } }
  const extensions = (config as Record<string, unknown>)['extensions']
  if (extensions && typeof extensions === 'object') {
    for (const [name, entry] of Object.entries(extensions as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const cmd = e['cmd'] ?? e['command']
      if (cmd) {
        servers.push({ source, name, transport: 'stdio', target: String(cmd) })
      }
    }
  }

  return servers
}

export default defineCommand({
  meta: { name: 'discover', description: 'Discover MCP servers from known config files' },
  args: {
    source: { type: 'string', description: 'Filter by source (e.g. claude-desktop)' },
    json: { type: 'boolean', description: 'Output JSON', default: false },
  },
  async run({ args }) {
    if (args.json) setJsonMode(true)
    const paths = getConfigPaths()
    const all: DiscoveredServer[] = []

    for (const [key, target] of Object.entries(paths)) {
      if (args.source && key !== args.source) continue
      try {
        const config = readConfig(target.path, target.format)
        if (config) {
          all.push(...extractServers(key, config))
        }
      } catch {
        // skip unreadable configs silently
      }
    }

    output(all, (servers) => {
      if (servers.length === 0) {
        log.muted('No MCP servers discovered.')
        return
      }
      renderTable(
        ['Source', 'Name', 'Transport', 'Command / URL'],
        servers.map((s) => [s.source, s.name, s.transport, s.target]),
      )
    })
  },
})
