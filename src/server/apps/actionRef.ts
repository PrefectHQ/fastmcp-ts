import { contextStore } from '../context'

/**
 * Resolve a logical tool name to its current external name inside a request
 * handler, accounting for any mount prefix applied by a parent server.
 *
 * Use this in providers that are built on bare FastMCP (not FastMCPApp) to
 * produce mount-prefix–aware action strings for Button components.
 */
export function actionRef(name: string): string {
  return contextStore.getStore()?.resolveToolName(name) ?? name
}
