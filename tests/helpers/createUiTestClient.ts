import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from '@modelcontextprotocol/client'
import type { FastMCP } from 'fastmcp-ts/server'
import type { TestClient } from './createTestClient'

/** Like createTestClient, but the MCP client advertises the io.modelcontextprotocol/ui extension. */
export async function createUiTestClient(mcp: FastMCP): Promise<TestClient> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()

  await mcp.connect(serverTransport)

  const client = new Client(
    { name: 'test-ui-client', version: '0.0.0' },
    { capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } } },
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
