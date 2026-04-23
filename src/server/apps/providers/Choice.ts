import { FastMCP } from '../../FastMCP'
import { actionRef } from '../actionRef'
import { Row, Button } from '../components'

export class Choice {
  readonly server: FastMCP

  constructor() {
    this.server = new FastMCP({ name: 'choice' })

    this.server.tool(
      {
        name: 'choice_present',
        description: 'Present a list of options for the user to choose from',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask the user' },
            options: { type: 'array', items: { type: 'string' }, description: 'The options to present' },
          },
          required: ['question', 'options'],
        },
        ui: { visibility: ['model', 'app'] },
      },
      (args: Record<string, unknown>) => {
        const options = (args.options as string[]) ?? []
        return Row(
          {},
          // Each button carries its option value as args so the host can
          // forward it to choice_select without extra state.
          options.map((opt) =>
            Button({ label: opt, action: actionRef('choice_select'), args: { option: opt } }),
          ),
        )
      },
    )

    this.server.resource(
      { uri: 'ui://choice_present', mimeType: 'text/html;profile=mcp-app', name: 'choice_present' },
      () => `<!doctype html><html><head><meta charset="utf-8"></head><body><!-- fastmcp ui-runtime placeholder --></body></html>`,
    )

    this.server.tool(
      {
        name: 'choice_select',
        description: "Record the user's selection",
        ui: { visibility: ['app'] },
      },
      (args: Record<string, unknown>) => ({ selected: args.option as string }),
    )
  }
}
