import { defineCommand } from 'citty'
import { output, setJsonMode } from '../ui/format.js'
import { log } from '../ui/output.js'

declare const __FASTMCP_VERSION__: string
declare const __MCP_SDK_VERSION__: string

export default defineCommand({
  meta: { name: 'version', description: 'Print version information' },
  args: {
    json: { type: 'boolean', description: 'Output JSON', default: false },
  },
  async run({ args }) {
    if (args.json) setJsonMode(true)
    const data = {
      fastmcp: __FASTMCP_VERSION__,
      'mcp-sdk': __MCP_SDK_VERSION__,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    }

    output(data, (d) => {
      for (const [key, value] of Object.entries(d)) {
        log.kv(key, value)
      }
    })
  },
})
