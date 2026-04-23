import { FastMCP } from '../FastMCP'
import type { ToolConfig } from '../FastMCP'
import { contextStore } from '../context'
import type { Component } from './components'
import type { Visibility } from './types'

export interface EntrypointConfig {
  name: string
  description: string
  title?: string
}

export interface BackendToolConfig {
  name: string
  description: string
  title?: string
  /** Defaults to ['app']. Pass ['model', 'app'] to also expose to the LLM. */
  visibility?: Visibility[]
}

export interface FastMCPAppOptions {
  name: string
  version?: string
}

export class FastMCPApp {
  readonly server: FastMCP

  constructor(options: FastMCPAppOptions) {
    this.server = new FastMCP({ name: options.name, version: options.version })
  }

  /**
   * Register an entry-point tool.
   * Entry-points are visible to the LLM (visibility: ['model', 'app']) and
   * automatically linked to a generated ui:// resource URI.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entrypoint(config: EntrypointConfig, handler: (args?: any) => Component): void {
    const resourceUri = `ui://${config.name}`
    const toolConfig: ToolConfig = {
      name: config.name,
      description: config.description,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ui: { visibility: ['model', 'app'], resourceUri },
    }
    this.server.tool(toolConfig, handler)
    // Stub resource so resources/read on the ui:// URI doesn't 404.
    // Replaced by the real UI runtime bundle when bundling is implemented.
    this.server.resource(
      { uri: resourceUri, mimeType: 'text/html;profile=mcp-app', name: config.name },
      () => `<!doctype html><html><head><meta charset="utf-8"></head><body><!-- fastmcp ui-runtime placeholder --></body></html>`,
    )
  }

  /**
   * Register a backend tool.
   * Backend tools are hidden from listTools by default (visibility: ['app']).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  backendTool(config: BackendToolConfig, handler: (args: any) => unknown): void {
    const visibility = config.visibility ?? ['app']
    const toolConfig: ToolConfig = {
      name: config.name,
      description: config.description,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ui: { visibility },
    }
    this.server.tool(toolConfig, handler)
  }

  /**
   * Returns a reference to a tool that resolves to the correct external name
   * (including any mount prefix) when evaluated inside a request handler.
   * Call inside a handler function — not at definition time.
   */
  toolRef(name: string): string {
    const ctx = contextStore.getStore()
    if (!ctx) return name
    return ctx.resolveToolName(name)
  }
}
