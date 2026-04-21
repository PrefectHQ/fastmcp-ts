// ---------------------------------------------------------------------------
// View types — simplified projections passed to transforms
// ---------------------------------------------------------------------------

export interface ToolView {
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]
}

export interface ResourceView {
  readonly uri: string
  readonly name: string
  readonly tags: readonly string[]
  readonly mimeType?: string
  readonly title?: string
}

export interface PromptView {
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]
}

// ---------------------------------------------------------------------------
// Synthesized tool — produced by a transform from other components
// ---------------------------------------------------------------------------

export interface SynthesizedTool {
  readonly name: string
  readonly description: string
  readonly inputSchema?: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: (args: any) => unknown
}

// ---------------------------------------------------------------------------
// Transform interface
// ---------------------------------------------------------------------------

export interface Transform {
  /**
   * Transform a tool view before it appears in list responses.
   * Return a modified view to rename/redescribe; return null to hide the tool
   * from list responses (it remains callable by its original name).
   */
  transformTool?(view: ToolView): ToolView | null

  /** Transform a static resource view. */
  transformResource?(view: ResourceView): ResourceView | null

  /** Transform a URI-template resource view. */
  transformResourceTemplate?(view: ResourceView): ResourceView | null

  /** Transform a prompt view. */
  transformPrompt?(view: PromptView): PromptView | null

  /**
   * Synthesize additional tools derived from the current resource and prompt lists.
   * Called at request time so the snapshot is always fresh.
   */
  synthesizeTools?(resources: ResourceView[], prompts: PromptView[]): SynthesizedTool[]
}

// ---------------------------------------------------------------------------
// Internal helper — apply a chain of transforms to a single view
// ---------------------------------------------------------------------------

export function applyTransformChain<T>(
  value: T,
  transforms: Transform[],
  pick: (t: Transform, v: T) => T | null | undefined,
): T | null {
  let current: T | null = value
  for (const t of transforms) {
    if (current === null) break
    const next = pick(t, current)
    if (next !== undefined) current = next
  }
  return current
}

// ---------------------------------------------------------------------------
// Built-in transforms
// ---------------------------------------------------------------------------

/** Rename a single tool. The original name still resolves at call time. */
export function renameTool(originalName: string, newName: string): Transform {
  return {
    transformTool: (v) => (v.name === originalName ? { ...v, name: newName } : v),
  }
}

/** Rewrite the description of a single tool. */
export function redescribeTool(toolName: string, description: string): Transform {
  return {
    transformTool: (v) => (v.name === toolName ? { ...v, description } : v),
  }
}

/**
 * Hide components whose predicate returns false.
 * Hidden items are removed from list responses but remain callable by original name.
 */
export class FilterTransform implements Transform {
  constructor(
    private readonly predicates: {
      tools?: (v: ToolView) => boolean
      resources?: (v: ResourceView) => boolean
      prompts?: (v: PromptView) => boolean
    },
  ) {}

  transformTool(v: ToolView): ToolView | null {
    return (this.predicates.tools?.(v) ?? true) ? v : null
  }
  transformResource(v: ResourceView): ResourceView | null {
    return (this.predicates.resources?.(v) ?? true) ? v : null
  }
  transformResourceTemplate(v: ResourceView): ResourceView | null {
    return (this.predicates.resources?.(v) ?? true) ? v : null
  }
  transformPrompt(v: PromptView): PromptView | null {
    return (this.predicates.prompts?.(v) ?? true) ? v : null
  }
}

/** Prefix all tool/prompt names and resource URIs with a string. */
export class NamespaceTransform implements Transform {
  constructor(private readonly prefix: string) {}

  transformTool(v: ToolView): ToolView {
    return { ...v, name: `${this.prefix}${v.name}` }
  }
  transformResource(v: ResourceView): ResourceView {
    return { ...v, uri: `${this.prefix}${v.uri}`, name: `${this.prefix}${v.name}` }
  }
  transformResourceTemplate(v: ResourceView): ResourceView {
    return { ...v, uri: `${this.prefix}${v.uri}`, name: `${this.prefix}${v.name}` }
  }
  transformPrompt(v: PromptView): PromptView {
    return { ...v, name: `${this.prefix}${v.name}` }
  }
}

/** Expose registered resources as a `list_resources` tool. */
export class ResourcesAsTools implements Transform {
  synthesizeTools(resources: ResourceView[]): SynthesizedTool[] {
    return [
      {
        name: 'list_resources',
        description: 'List all available MCP resources',
        inputSchema: { type: 'object', properties: {} },
        handler: () => resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })),
      },
    ]
  }
}

/** Expose registered prompts as a `list_prompts` tool. */
export class PromptsAsTools implements Transform {
  synthesizeTools(_resources: ResourceView[], prompts: PromptView[]): SynthesizedTool[] {
    return [
      {
        name: 'list_prompts',
        description: 'List all available MCP prompts',
        inputSchema: { type: 'object', properties: {} },
        handler: () => prompts.map((p) => ({ name: p.name, description: p.description })),
      },
    ]
  }
}

/**
 * Expose only components whose tags include the specified version string.
 * Components with no tags are always excluded.
 */
export class VersionFilter implements Transform {
  constructor(private readonly version: string) {}

  private _matches(tags: readonly string[]): boolean {
    return tags.includes(this.version)
  }

  transformTool(v: ToolView): ToolView | null {
    return this._matches(v.tags) ? v : null
  }
  transformResource(v: ResourceView): ResourceView | null {
    return this._matches(v.tags) ? v : null
  }
  transformResourceTemplate(v: ResourceView): ResourceView | null {
    return this._matches(v.tags) ? v : null
  }
  transformPrompt(v: PromptView): PromptView | null {
    return this._matches(v.tags) ? v : null
  }
}
