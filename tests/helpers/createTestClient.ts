import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from '@modelcontextprotocol/client'
import type { FastMCP } from 'fastmcp-ts/server'

export interface TestClient {
  client: Client
  close: () => Promise<void>
}

export async function createTestClient(mcp: FastMCP): Promise<TestClient> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()

  await mcp.connect(serverTransport)

  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: {} },
  )
  await client.connect(clientTransport)

  return {
    client,
    close: async () => {
      await client.close()
      await mcp.close()
    },
  }
}
