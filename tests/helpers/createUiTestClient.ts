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
    {
      // mimeTypes is REQUIRED on the client's extension declaration per SEP-1865's
      // Client<>Server Capability Negotiation section — a bare `{}` value is not a
      // spec-compliant UI-capable declaration (see isUiCapable in apps/types.ts).
      capabilities: {
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
      },
    },
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
