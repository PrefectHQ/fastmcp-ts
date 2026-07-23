import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { FastMCP } from 'fastmcp-ts/server'
import type { ServerEventBus } from 'fastmcp-ts/server'

// ---------------------------------------------------------------------------
// Modern era (2026-07-28): tools/prompts/resources list_changed and
// resources/updated are delivered only on a subscriptions/listen stream the
// client opted into — the server never sends an un-requested notification. On
// the server side this means _notifyToolListChanged/etc. must also publish to
// the modern HTTP handler's own change-event bus (createMcpHandler serves
// subscriptions/listen itself; nothing to register — see _getModernHandler).
// ---------------------------------------------------------------------------

describe('Server — subscriptions/listen (modern era list-changed delivery)', () => {
  let close: () => Promise<void>

  afterEach(async () => {
    await close?.()
  })

  it('a modern client receives notifications/tools/list_changed when a tool is registered after connecting', async () => {
    const mcp = new FastMCP({ name: 'subs-test' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    close = () => mcp.close()

    let resolveChanged!: (tools: unknown[]) => void
    const changed = new Promise<unknown[]>((resolve) => {
      resolveChanged = resolve
    })

    const client = new Client(
      { name: 'modern-client', version: '0.0.0' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (err, tools) => {
              if (!err && tools) resolveChanged(tools)
            },
          },
        },
      },
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address!.port}/mcp`)),
    )
    expect(client.getProtocolEra()).toBe('modern')

    mcp.tool({ name: 'newTool', description: 'added after connect' }, () => 'ok')

    const tools = await changed
    expect((tools as Array<{ name: string }>).map((t) => t.name)).toContain('newTool')

    await client.close()
  })

  it('a modern client receives notifications/resources/list_changed when a resource is registered after connecting', async () => {
    const mcp = new FastMCP({ name: 'subs-test' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    close = () => mcp.close()

    let resolveChanged!: (resources: unknown[]) => void
    const changed = new Promise<unknown[]>((resolve) => {
      resolveChanged = resolve
    })

    const client = new Client(
      { name: 'modern-client', version: '0.0.0' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        listChanged: {
          resources: {
            debounceMs: 0,
            onChanged: (err, resources) => {
              if (!err && resources) resolveChanged(resources)
            },
          },
        },
      },
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address!.port}/mcp`)),
    )

    mcp.resource({ uri: 'memo://readme' }, () => 'hello')

    const resources = await changed
    expect((resources as Array<{ uri: string }>).map((r) => r.uri)).toContain('memo://readme')

    await client.close()
  })

  it('a modern client receives notifications/prompts/list_changed when a prompt is registered after connecting', async () => {
    const mcp = new FastMCP({ name: 'subs-test' })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    close = () => mcp.close()

    let resolveChanged!: (prompts: unknown[]) => void
    const changed = new Promise<unknown[]>((resolve) => {
      resolveChanged = resolve
    })

    const client = new Client(
      { name: 'modern-client', version: '0.0.0' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        listChanged: {
          prompts: {
            debounceMs: 0,
            onChanged: (err, prompts) => {
              if (!err && prompts) resolveChanged(prompts)
            },
          },
        },
      },
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address!.port}/mcp`)),
    )

    mcp.prompt({ name: 'newPrompt', description: 'added after connect' }, () => 'hello')

    const prompts = await changed
    expect((prompts as Array<{ name: string }>).map((p) => p.name)).toContain('newPrompt')

    await client.close()
  })

  it('FastMCPOptions.eventBus lets a custom ServerEventBus observe published change events', async () => {
    const published: string[] = []
    const listeners = new Set<Parameters<ServerEventBus['subscribe']>[0]>()
    const eventBus: ServerEventBus = {
      publish: (event) => {
        published.push(event.kind)
        for (const listener of listeners) listener(event)
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }

    const mcp = new FastMCP({ name: 'subs-test', eventBus })
    await mcp.run({ transport: 'http', port: 0, host: '127.0.0.1' })
    close = () => mcp.close()

    let resolveChanged!: () => void
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve
    })
    const client = new Client(
      { name: 'modern-client', version: '0.0.0' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        listChanged: { tools: { debounceMs: 0, onChanged: () => resolveChanged() } },
      },
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address!.port}/mcp`)),
    )

    mcp.tool({ name: 'anotherTool', description: 'test' }, () => 'ok')
    await changed

    expect(published).toContain('tools_list_changed')
    await client.close()
  })
})
