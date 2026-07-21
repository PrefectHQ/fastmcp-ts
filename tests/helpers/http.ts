import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client } from '@modelcontextprotocol/client'

export interface HttpTestClient {
  client: Client
  close: () => Promise<void>
}

/** Connect a full MCP client to an HTTP server with an optional bearer token. */
export async function connectHttpClient(url: URL, bearer?: string): Promise<HttpTestClient> {
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
  })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

/** Send a raw MCP initialize POST to a URL with an optional bearer token. */
export async function rawPost(url: URL, bearer?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    }),
  })
}
