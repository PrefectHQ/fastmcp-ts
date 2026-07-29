import type { ClientCapabilities } from '@modelcontextprotocol/client'

interface InferredClientCapabilities {
  sampling: boolean
  elicitation: boolean
  rootsListChanged?: boolean
}

export function buildClientCapabilities(
  supplied: ClientCapabilities | undefined,
  inferred: InferredClientCapabilities,
): ClientCapabilities {
  const capabilities: ClientCapabilities = { ...supplied }

  if (inferred.sampling) {
    capabilities.sampling = {
      ...supplied?.sampling,
      tools: supplied?.sampling?.tools ?? {},
    }
  }

  if (inferred.elicitation) {
    const elicitation = supplied?.elicitation
    capabilities.elicitation = elicitation
      ? { ...elicitation, form: elicitation.form ?? {} }
      : {}
  }

  if (inferred.rootsListChanged !== undefined) {
    capabilities.roots = {
      ...supplied?.roots,
      listChanged: inferred.rootsListChanged,
    }
  }

  return capabilities
}
