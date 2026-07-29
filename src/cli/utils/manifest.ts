import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/client'
import type { Tool, Resource, ResourceTemplate, Prompt } from '../../client/results.js'

/**
 * Builder for `inspect --format fastmcp`: the manifest shape the Python
 * FastMCP CLI emits for `fastmcp inspect <spec> --format fastmcp`
 * (`fastmcp.utilities.inspect.format_fastmcp_info`). Snake_case keys, the
 * Python field set, and Python's null semantics — so cross-language consumers
 * (Horizon build tooling) can read one manifest schema from both CLIs.
 *
 * The Python CLI loads the server in-process and reads server-side state; this
 * CLI inspects over an MCP client connection. Fields that never cross the wire
 * are emitted as `null`, matching Python's own client-based inspection path
 * (`inspect_fastmcp_v1`): component `tags`, template `parameters`, and — for
 * servers that do not advertise them — `instructions`, `website_url`, and
 * `icons`. Values that do cross the wire pass through in protocol shape
 * (`annotations`, `icons`, `meta` contents keep their camelCase keys, exactly
 * as Python emits them).
 */

/** Python `FastMCPComponent.key` format: `{prefix}:{identifier}@{version}`.
 * Component versions are server-side state and never cross the wire, so the
 * version suffix is always empty here (`tool:echo@`). */
function componentKey(prefix: string, identifier: string): string {
  return `${prefix}:${identifier}@`
}

export interface FastmcpManifestInput {
  serverInfo: Implementation | undefined
  instructions: string | undefined
  capabilities: ServerCapabilities | undefined
  /** Python `server_generation`: 2 for a FastMCP server loaded from a file
   * (the only case Python's inspect supports); `null` when inspecting an
   * arbitrary server over a URL or stdio command, where the generation is
   * unknowable from the wire. */
  generation: number | null
  fastmcpVersion: string
  mcpVersion: string
  tools: Tool[]
  prompts: Prompt[]
  resources: Resource[]
  templates: ResourceTemplate[]
}

/** JSON value type for the manifest — plain data, no undefined. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function buildFastmcpManifest(input: FastmcpManifestInput): Record<string, Json> {
  const { serverInfo } = input
  return {
    server: {
      name: serverInfo?.name ?? null,
      instructions: input.instructions ?? null,
      // Python reports an unset version as null, never ''.
      version: serverInfo?.version || null,
      website_url: serverInfo?.websiteUrl ?? null,
      icons: (serverInfo?.icons as Json) ?? null,
      generation: input.generation,
      capabilities: (input.capabilities as Json) ?? {},
    },
    environment: {
      fastmcp: input.fastmcpVersion,
      mcp: input.mcpVersion,
    },
    tools: input.tools.map((t) => ({
      key: componentKey('tool', t.name),
      name: t.name,
      description: t.description ?? null,
      input_schema: (t.inputSchema as Json) ?? {},
      output_schema: (t.outputSchema as Json) ?? null,
      annotations: (t.annotations as Json) ?? null,
      tags: null,
      title: t.title ?? null,
      icons: (t.icons as Json) ?? null,
      meta: (t._meta as Json) ?? null,
    })),
    prompts: input.prompts.map((p) => ({
      key: componentKey('prompt', p.name),
      name: p.name,
      description: p.description ?? null,
      arguments: p.arguments?.length
        ? p.arguments.map((a) => ({
            name: a.name,
            description: a.description ?? null,
            required: a.required ?? null,
          }))
        : null,
      tags: null,
      title: p.title ?? null,
      icons: (p.icons as Json) ?? null,
      meta: (p._meta as Json) ?? null,
    })),
    resources: input.resources.map((r) => ({
      key: componentKey('resource', r.uri),
      uri: r.uri,
      name: r.name ?? null,
      description: r.description ?? null,
      mime_type: r.mimeType ?? null,
      annotations: (r.annotations as Json) ?? null,
      tags: null,
      title: r.title ?? null,
      icons: (r.icons as Json) ?? null,
      meta: (r._meta as Json) ?? null,
    })),
    templates: input.templates.map((t) => ({
      key: componentKey('template', t.uriTemplate),
      uri_template: t.uriTemplate,
      name: t.name ?? null,
      description: t.description ?? null,
      mime_type: t.mimeType ?? null,
      parameters: null,
      annotations: (t.annotations as Json) ?? null,
      tags: null,
      title: t.title ?? null,
      icons: (t.icons as Json) ?? null,
      meta: (t._meta as Json) ?? null,
    })),
  }
}
