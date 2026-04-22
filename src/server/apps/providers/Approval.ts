import { FastMCP } from '../../FastMCP'
import { Column, Button } from '../components'

export class Approval {
  readonly server: FastMCP

  constructor() {
    this.server = new FastMCP({ name: 'approval' })

    // LLM-visible entry-point: renders confirm/deny UI
    this.server.tool(
      { name: 'approval_request', description: 'Present a confirm/deny approval card to the user', ui: { visibility: ['model', 'app'] } },
      (args: Record<string, unknown>) => {
        const message = (args.message as string) ?? 'Approve?'
        return Column({}, [
          Button({ label: message, action: 'approval_confirm' }),
          Button({ label: 'Deny', action: 'approval_deny', variant: 'secondary' }),
        ])
      },
    )

    // Backend-only: called by the host bridge when user clicks confirm
    this.server.tool(
      { name: 'approval_confirm', description: 'Record a confirmed approval decision', ui: { visibility: ['app'] } },
      () => ({ decision: 'approved' as const }),
    )

    // Backend-only: called by the host bridge when user clicks deny
    this.server.tool(
      { name: 'approval_deny', description: 'Record a denied approval decision', ui: { visibility: ['app'] } },
      () => ({ decision: 'denied' as const }),
    )
  }
}
