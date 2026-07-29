import type { ClientCapabilities } from '@modelcontextprotocol/client'

interface InferredClientCapabilities {
  sampling: boolean
  elicitation: boolean
  rootsListChanged?: boolean
}

/** Build the capabilities advertised by a FastMCP client. */
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
    capabilities.elicitation =
      supplied?.elicitation === undefined
        ? {}
        : {
            ...supplied.elicitation,
            form: supplied.elicitation.form ?? {},
          }
  }

  if (inferred.rootsListChanged !== undefined) {
    capabilities.roots = {
      ...supplied?.roots,
      listChanged: inferred.rootsListChanged,
    }
  }

  return capabilities
}
