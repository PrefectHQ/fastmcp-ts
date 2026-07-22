// ---------------------------------------------------------------------------
// Low-level HTTP probes for the auth/middleware suites (single-era, legacy).
//
// This file is NOT the dual-era client harness. For connecting a client across
// the four transport/era combos {stdio,http}×{legacy,modern}, use
// `tests/helpers/eras.ts` (`connectEra` / `describeEachEra` / `ERA_COMBOS`) — it
// negotiates the era per combo and asserts the negotiated era after connect.
// The helpers here exist only to poke the legacy HTTP path directly (raw bytes /
// bearer-token checks) where a full era-aware connection is not the point.
// ---------------------------------------------------------------------------

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client } from '@modelcontextprotocol/client'

/**
 * Protocol version for the legacy (2025-era) `initialize` handshake that {@link rawPost}
 * sends. This is an EXPLICIT era choice — `rawPost` exists to probe the server's legacy
 * HTTP path (e.g. auth rejections before a session exists), so it deliberately opens with
 * a legacy `initialize` rather than a modern `server/discover`. For full dual-era client
 * connections use `connectEra` from `./eras` (the dual-era harness), which negotiates the
 * era per combo.
 */
export const LEGACY_INITIALIZE_PROTOCOL_VERSION = '2024-11-05'

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
        protocolVersion: LEGACY_INITIALIZE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    }),
  })
}
