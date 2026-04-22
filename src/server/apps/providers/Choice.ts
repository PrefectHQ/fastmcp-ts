import { FastMCP } from '../../FastMCP'
import { Row, Button } from '../components'

export class Choice {
  readonly server: FastMCP

  constructor() {
    this.server = new FastMCP({ name: 'choice' })

    // LLM-visible: renders a row of clickable options
    this.server.tool(
      {
        name: 'choice_present',
        description: 'Present a list of options for the user to choose from',
        ui: { visibility: ['model', 'app'] },
      },
      (args: Record<string, unknown>) => {
        const options = (args.options as string[]) ?? []
        return Row(
          {},
          options.map((opt: string) =>
            Button({ label: opt, action: `choice_select` }),
          ),
        )
      },
    )

    // Backend-only: called by host bridge when user clicks an option
    this.server.tool(
      { name: 'choice_select', description: 'Record the user\'s selection', ui: { visibility: ['app'] } },
      (args: Record<string, unknown>) => ({ selected: args.option as string }),
    )
  }
}
