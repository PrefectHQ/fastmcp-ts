import { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { parseTemplate } from 'url-template'
import { FastMCP } from './FastMCP'
import { ToolResult } from './tool'
import { ResourceResult } from './resource'
import { PromptResult } from './prompt'
import type { PromptMessage } from './prompt'

type StdioTransport = {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** How long (ms) before the proxy re-fetches component lists. Default 30 000. Set 0 for notifications-only. */
  cacheTtl?: number
}

type HttpTransport = {
  type: 'http'
  url: string
  requestInit?: RequestInit
  /** How long (ms) before the proxy re-fetches component lists. Default 30 000. Set 0 for notifications-only. */
  cacheTtl?: number
}

export type ProxyTransport = StdioTransport | HttpTransport

/**
 * Build a FastMCP proxy around an already-connected MCP Client.
 * Exported to enable testing with in-memory transports.
 */
export async function buildProxyFromClient(
  client: Client,
  options?: { cacheTtl?: number; name?: string },
): Promise<FastMCP> {
  const cacheTtl = options?.cacheTtl ?? 30_000

  const serverInfo = client.getServerVersion()
  const proxyName = options?.name ?? serverInfo?.name ?? 'proxy'
  const proxyVersion = serverInfo?.version ?? '0.0.1'

  const proxy = new FastMCP({ name: proxyName, version: proxyVersion })

  // Track which component identifiers were registered by this proxy so we can diff on resync.
  const proxiedTools = new Set<string>()
  const proxiedResources = new Set<string>()
  const proxiedPrompts = new Set<string>()

  // Per-type timestamp of last successful sync (0 forces an immediate resync on first list request).
  const lastSync = { tools: 0, resources: 0, prompts: 0 }

  async function resyncTools(): Promise<void> {
    // client.listTools() with no cursor auto-aggregates every page for us (v2 SDK
    // behavior — see ClientOptions.listMaxPages, default cap 64 pages).
    const { tools } = await client.listTools()

    const incoming = new Set(tools.map((t) => t.name))

    for (const name of proxiedTools) {
      if (!incoming.has(name)) {
        proxy._removeTool(name)
        proxiedTools.delete(name)
      }
    }

    for (const tool of tools) {
      if (proxiedTools.has(tool.name)) {
        // Update metadata if it changed
        proxy._removeTool(tool.name)
        proxiedTools.delete(tool.name)
      }
      proxy.tool(
        {
          name: tool.name,
          ...(tool.title !== undefined ? { title: tool.title } : {}),
          description: tool.description ?? tool.name,
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
        },
        async (args: unknown) => {
          const result = await client.callTool(
            { name: tool.name, arguments: args as Record<string, unknown> }
          )
          // Zod infers _meta on content items as Record<string,unknown> but
          // CallToolResult types it more specifically — identical at runtime.
          return new ToolResult(result as unknown as CallToolResult)
        },
      )
      proxiedTools.add(tool.name)
    }

    lastSync.tools = Date.now()
  }

  async function resyncResources(): Promise<void> {
    const incoming = new Set<string>()

    try {
      // client.listResources() with no cursor auto-aggregates every page for us.
      const { resources } = await client.listResources()

      for (const resource of resources) {
        incoming.add(resource.uri)
        if (!proxiedResources.has(resource.uri)) {
          proxy.resource(
            {
              uri: resource.uri,
              name: resource.name,
              ...(resource.description !== undefined ? { description: resource.description } : {}),
              ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
            },
            async () => {
              const result = await client.readResource({ uri: resource.uri })
              return new ResourceResult(
                result.contents as Array<{
                  uri: string
                  mimeType?: string
                  text?: string
                  blob?: string
                }>,
              )
            },
          )
          proxiedResources.add(resource.uri)
        }
      }
    } catch {
      // server may not support resources
    }

    try {
      // client.listResourceTemplates() with no cursor auto-aggregates every page for us.
      const { resourceTemplates } = await client.listResourceTemplates()

      for (const template of resourceTemplates) {
        const uriTemplate = template.uriTemplate
        incoming.add(uriTemplate)
        if (!proxiedResources.has(uriTemplate)) {
          const expander = parseTemplate(uriTemplate)
          proxy.resource(
            {
              uri: uriTemplate,
              name: template.name,
              ...(template.description !== undefined
                ? { description: template.description }
                : {}),
              ...(template.mimeType !== undefined ? { mimeType: template.mimeType } : {}),
            },
            async (params?: Record<string, string>) => {
              const actualUri = params ? expander.expand(params) : uriTemplate
              const result = await client.readResource({ uri: actualUri })
              return new ResourceResult(
                result.contents as Array<{
                  uri: string
                  mimeType?: string
                  text?: string
                  blob?: string
                }>,
              )
            },
          )
          proxiedResources.add(uriTemplate)
        }
      }
    } catch {
      // server may not support resource templates
    }

    for (const uri of proxiedResources) {
      if (!incoming.has(uri)) {
        proxy._removeResource(uri)
        proxiedResources.delete(uri)
      }
    }

    lastSync.resources = Date.now()
  }

  async function resyncPrompts(): Promise<void> {
    // client.listPrompts() with no cursor auto-aggregates every page for us.
    const { prompts } = await client.listPrompts()

    const incoming = new Set(prompts.map((p) => p.name))

    for (const name of proxiedPrompts) {
      if (!incoming.has(name)) {
        proxy._removePrompt(name)
        proxiedPrompts.delete(name)
      }
    }

    for (const prompt of prompts) {
      if (!proxiedPrompts.has(prompt.name)) {
        proxy.prompt(
          {
            name: prompt.name,
            description: prompt.description,
            ...(prompt.arguments?.length ? { arguments: prompt.arguments } : {}),
          },
          async (args?: Record<string, string>) => {
            const result = await client.getPrompt({ name: prompt.name, arguments: args })
            return new PromptResult(result.messages as PromptMessage[], result.description)
          },
        )
        proxiedPrompts.add(prompt.name)
      }
    }

    lastSync.prompts = Date.now()
  }

  // Initial sync.
  await Promise.all([
    resyncTools().catch(() => {}),
    resyncResources().catch(() => {}),
    resyncPrompts().catch(() => {}),
  ])

  // Subscribe to backend change notifications for immediate resync.
  client.setNotificationHandler('notifications/tools/list_changed', () => {
    resyncTools().catch(() => {})
  })
  client.setNotificationHandler('notifications/resources/list_changed', () => {
    resyncResources().catch(() => {})
  })
  client.setNotificationHandler('notifications/prompts/list_changed', () => {
    resyncPrompts().catch(() => {})
  })

  // TTL-based lazy resync: re-fetch on list requests when the cache is stale.
  if (cacheTtl > 0) {
    proxy.use({
      async onListTools(ctx, next) {
        if (Date.now() - lastSync.tools > cacheTtl) await resyncTools().catch(() => {})
        return next()
      },
      async onListResources(ctx, next) {
        if (Date.now() - lastSync.resources > cacheTtl) await resyncResources().catch(() => {})
        return next()
      },
      async onListResourceTemplates(ctx, next) {
        if (Date.now() - lastSync.resources > cacheTtl) await resyncResources().catch(() => {})
        return next()
      },
      async onListPrompts(ctx, next) {
        if (Date.now() - lastSync.prompts > cacheTtl) await resyncPrompts().catch(() => {})
        return next()
      },
    })
  }

  proxy._addCloseCallback(async () => {
    await client.close()
  })

  return proxy
}

/**
 * Create a FastMCP instance that proxies all requests to a remote MCP server.
 * The returned instance can be mounted onto a parent server via `parent.mount(proxy)`.
 *
 * Component lists (tools, resources, prompts) are kept in sync via:
 *  - Change notifications from the backend (immediate resync)
 *  - TTL-based lazy resync on each list request (configurable via `cacheTtl`, default 30 s)
 */
export async function createProxy(config: ProxyTransport, name?: string): Promise<FastMCP> {
  let transport: import('@modelcontextprotocol/client').Transport

  if (config.type === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    })
  } else {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/client'
    )
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.requestInit,
    })
  }

  const client = new Client(
    { name: name ?? 'fastmcp-proxy', version: '0.0.1' },
    { capabilities: {} },
  )

  await client.connect(transport)

  return buildProxyFromClient(client, { cacheTtl: config.cacheTtl, name })
}
