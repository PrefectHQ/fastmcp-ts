import { runInNewContext } from 'node:vm'
import { FastMCP } from '../FastMCP'
import { ToolResult } from '../tool'
import { COMPONENT_CATALOG } from './components'
import * as Components from './components'

export class GenerativeUI {
  readonly server: FastMCP

  constructor() {
    this.server = new FastMCP({ name: 'generative-ui' })

    // Regular LLM tool — catalog lookup, always returns structured data
    this.server.tool(
      {
        name: 'search_components',
        description: 'List available UI components with their types and descriptions',
      },
      () => new ToolResult({
        content: [{ type: 'text', text: JSON.stringify(COMPONENT_CATALOG) }],
      }),
    )

    // LLM-visible tool — executes component code in an isolated sandbox
    this.server.tool(
      {
        name: 'generate_ui',
        description: 'Execute a UI component expression and return the component tree. Use search_components to discover available component APIs first.',
        ui: { visibility: ['model'] },
      },
      (args: Record<string, unknown>) => {
        const { code } = args as { code: string }
        // Sandbox: only the component builder functions are in scope — no Node globals
        const sandbox: Record<string, unknown> = { ...Components }
        delete sandbox['COMPONENT_CATALOG']

        try {
          return runInNewContext(code, sandbox, { timeout: 2000 })
        } catch (err) {
          throw new Error(`[generate_ui] ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    )
  }
}
