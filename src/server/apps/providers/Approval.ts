import { FastMCP } from '../../FastMCP'
import { actionRef } from '../actionRef'
import { Column, Text, Button } from '../components'

export class Approval {
  readonly server: FastMCP

  constructor() {
    this.server = new FastMCP({ name: 'approval' })

    this.server.tool(
      {
        name: 'approval_request',
        description: 'Present a confirm/deny approval card to the user',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The question or action to seek approval for' },
          },
          required: ['message'],
        },
        ui: { visibility: ['model', 'app'] },
      },
      (args: Record<string, unknown>) => {
        const message = (args.message as string) ?? 'Approve?'
        return Column({}, [
          Text(message),
          Button({ label: 'Confirm', action: actionRef('approval_confirm') }),
          Button({ label: 'Deny', action: actionRef('approval_deny'), variant: 'secondary' }),
        ])
      },
    )

    this.server.tool(
      {
        name: 'approval_confirm',
        description: 'Record a confirmed approval decision',
        ui: { visibility: ['app'] },
      },
      () => ({ decision: 'approved' as const }),
    )

    this.server.tool(
      {
        name: 'approval_deny',
        description: 'Record a denied approval decision',
        ui: { visibility: ['app'] },
      },
      () => ({ decision: 'denied' as const }),
    )
  }
}
