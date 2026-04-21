import { describe, it, expect } from 'vitest'
import { FastMCP } from 'fastmcp-ts/server'
import { Client } from 'fastmcp-ts/client'

async function withServer(
  setup: (mcp: FastMCP) => void,
  fn: (client: Client) => Promise<void>,
) {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  setup(mcp)
  const client = await Client.connect(mcp)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

describe('Client — Prompts', () => {
  describe('listPrompts()', () => {
    it('returns an array of prompt definitions with name and description', async () => {
      await withServer(
        (mcp) => {
          mcp.prompt({ name: 'greet', description: 'generates a greeting' }, () => 'hello')
        },
        async (client) => {
          const prompts = await client.listPrompts()
          expect(prompts).toBeInstanceOf(Array)
          const greet = prompts.find((p) => p.name === 'greet')
          expect(greet).toBeDefined()
          expect(greet!.description).toBe('generates a greeting')
        },
      )
    })

    it('each definition includes the expected argument schema', async () => {
      await withServer(
        (mcp) => {
          mcp.prompt(
            {
              name: 'summarise',
              arguments: [
                { name: 'text', description: 'text to summarise', required: true },
                { name: 'lang', description: 'output language' },
              ],
            },
            ({ text, lang } = {}) => `summarise ${text} in ${lang}`,
          )
        },
        async (client) => {
          const prompts = await client.listPrompts()
          const summarise = prompts.find((p) => p.name === 'summarise')
          expect(summarise).toBeDefined()
          expect(summarise!.arguments).toBeInstanceOf(Array)
          const textArg = summarise!.arguments?.find((a) => a.name === 'text')
          expect(textArg?.required).toBe(true)
        },
      )
    })
  })

  describe('getPrompt()', () => {
    it('returns messages with role and content', async () => {
      await withServer(
        (mcp) => {
          mcp.prompt({ name: 'hello' }, () => 'hello world')
        },
        async (client) => {
          const result = await client.getPrompt('hello')
          expect(result.messages).toBeInstanceOf(Array)
          expect(result.messages.length).toBeGreaterThan(0)
          expect(result.messages[0]).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'hello world' },
          })
        },
      )
    })

    it('passes provided arguments to the server prompt template', async () => {
      await withServer(
        (mcp) => {
          mcp.prompt(
            { name: 'echo', arguments: [{ name: 'msg', required: true }] },
            ({ msg } = {}) => `you said: ${msg}`,
          )
        },
        async (client) => {
          const result = await client.getPrompt('echo', { msg: 'hi there' })
          expect(result.messages[0]).toMatchObject({
            content: { type: 'text', text: 'you said: hi there' },
          })
        },
      )
    })
  })
})
