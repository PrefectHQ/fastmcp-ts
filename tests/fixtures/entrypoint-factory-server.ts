/**
 * Fixture demonstrating entrypoint *function* definitions — a factory export
 * (sync or async, zero-arg) that returns a FastMCP instance when called. The
 * CLI's entrypoint bootstrap calls the function and validates the result.
 */
import { FastMCP } from '../../src/server/index.js'
import { z } from 'zod'

function buildServer(name: string): FastMCP {
  const server = new FastMCP({ name, version: '1.0.0' })
  server.tool(
    { name: 'echo', description: 'Echo a message back', input: z.object({ message: z.string() }) },
    async ({ message }) => message,
  )
  return server
}

export function createServer(): FastMCP {
  return buildServer('entrypoint-factory-fixture')
}

export async function createServerAsync(): Promise<FastMCP> {
  await new Promise((resolve) => setTimeout(resolve, 10))
  return buildServer('entrypoint-async-factory-fixture')
}
