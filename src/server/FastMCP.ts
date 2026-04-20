import { Server } from '@modelcontextprotocol/sdk/server'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport'

export interface FastMCPOptions {
  name: string
  version?: string
}

export class FastMCP {
  readonly name: string
  readonly version: string

  private _server: Server

  constructor(options: FastMCPOptions) {
    this.name = options.name
    this.version = options.version ?? '0.0.1'

    this._server = new Server(
      { name: this.name, version: this.version },
      { capabilities: {} },
    )
  }

  async connect(transport: Transport): Promise<void> {
    await this._server.connect(transport)
  }

  async close(): Promise<void> {
    await this._server.close()
  }
}
