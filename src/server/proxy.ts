import { Client } from '@modelcontextprotocol/sdk/client/index'
import { parseTemplate } from 'url-template'
import { FastMCP } from './FastMCP'
import { ToolResult } from './tool'
import { ResourceResult } from './resource'
import { PromptResult } from './prompt'
import type { PromptMessage } from './prompt'

export type ProxyTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; requestInit?: RequestInit }

/**
 * Create a FastMCP instance that proxies all requests to a remote MCP server.
 * The returned instance can be mounted onto a parent server via `parent.mount(proxy)`.
 */
export async function createProxy(config: ProxyTransport, name?: string): Promise<FastMCP> {
  let transport: import('@modelcontextprotocol/sdk/shared/transport').Transport

  if (config.type === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio')
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    })
  } else {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp'
    )
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.requestInit,
    })
  }

  const client = new Client(
    { name: name ?? 'fastmcp-proxy', version: '0.0.1' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )

  await client.connect(transport)

  const serverInfo = client.getServerVersion()
  const proxyName = name ?? serverInfo?.name ?? 'proxy'
  const proxyVersion = serverInfo?.version ?? '0.0.1'

  const proxy = new FastMCP({ name: proxyName, version: proxyVersion })

  async function syncTools(): Promise<void> {
    try {
      const { tools } = await client.listTools()
      for (const tool of tools) {
        proxy.tool(
          {
            name: tool.name,
            ...(tool.title !== undefined ? { title: tool.title } : {}),
            description: tool.description ?? tool.name,
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
          },
          async (args: unknown) => {
            const result = await client.callTool({
              name: tool.name,
              arguments: args as Record<string, unknown>,
            })
            return new ToolResult(result)
          },
        )
      }
    } catch {
      // server may not support tools
    }
  }

  async function syncResources(): Promise<void> {
    try {
      const { resources } = await client.listResources()
      for (const resource of resources) {
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
              result.contents as Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>,
            )
          },
        )
      }
    } catch {
      // server may not support resources
    }

    try {
      const { resourceTemplates } = await client.listResourceTemplates()
      for (const template of resourceTemplates) {
        const uriTemplate = template.uriTemplate
        const expander = parseTemplate(uriTemplate)
        proxy.resource(
          {
            uri: uriTemplate,
            name: template.name,
            ...(template.description !== undefined ? { description: template.description } : {}),
            ...(template.mimeType !== undefined ? { mimeType: template.mimeType } : {}),
          },
          async (params?: Record<string, string>) => {
            const actualUri = params ? expander.expand(params) : uriTemplate
            const result = await client.readResource({ uri: actualUri })
            return new ResourceResult(
              result.contents as Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>,
            )
          },
        )
      }
    } catch {
      // server may not support resource templates
    }
  }

  async function syncPrompts(): Promise<void> {
    try {
      const { prompts } = await client.listPrompts()
      for (const prompt of prompts) {
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
      }
    } catch {
      // server may not support prompts
    }
  }

  await Promise.all([syncTools(), syncResources(), syncPrompts()])

  proxy._addCloseCallback(async () => {
    await client.close()
  })

  return proxy
}
