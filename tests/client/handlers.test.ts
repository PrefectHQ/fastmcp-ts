import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod/v4'
import { FastMCP } from 'fastmcp-ts/server'
import { Client } from 'fastmcp-ts/client'
import type { LogMessage, LoggingLevel, SamplingHandler, ElicitationHandler } from 'fastmcp-ts/client'

async function withServer(
  setup: (mcp: FastMCP) => void,
  fn: (client: Client) => Promise<void>,
  clientOptions?: Parameters<typeof Client.connect>[1],
) {
  const mcp = new FastMCP({ name: 'test', version: '1.0.0' })
  setup(mcp)
  const client = await Client.connect(mcp, clientOptions)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

describe('Client — Handlers', () => {
  describe('logHandler', () => {
    it('is called with a LogMessage when the server emits a log notification', async () => {
      const received: LogMessage[] = []
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'logger', input: z.object({}) }, async () => {
            await mcp.getContext().info('hello from tool')
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('logger', {})
          expect(received).toHaveLength(1)
          expect(received[0]).toMatchObject({ level: 'info', data: 'hello from tool' })
        },
        { handlers: { log: (msg) => { received.push(msg) } } },
      )
    })

    it('LogMessage includes level, optional logger name, and data payload', async () => {
      const received: LogMessage[] = []
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'named', input: z.object({}) }, async () => {
            await mcp.getContext().log('warning', 'watch out', 'my-logger')
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('named', {})
          expect(received[0]).toMatchObject({
            level: 'warning',
            logger: 'my-logger',
            data: 'watch out',
          })
        },
        { handlers: { log: (msg) => { received.push(msg) } } },
      )
    })

    it('handles all eight severity levels', async () => {
      const levels: string[] = []
      const allLevels = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'allLevels', input: z.object({}) }, async () => {
            const ctx = mcp.getContext()
            for (const lvl of allLevels) {
              await ctx.log(lvl, 'msg')
            }
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('allLevels', {})
          expect(levels).toEqual([...allLevels])
        },
        { handlers: { log: (msg) => { levels.push(msg.level) } } },
      )
    })
  })

  describe('progressHandler', () => {
    it('onProgress callback is called when a tool reports progress', async () => {
      const progressCalls: Array<[number, number | undefined, string | undefined]> = []
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'progressor', input: z.object({}) }, async () => {
            await mcp.getContext().reportProgress(50, 100, 'halfway')
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('progressor', {}, {
            onProgress: (progress, total, message) => {
              progressCalls.push([progress, total, message])
            },
          })
          expect(progressCalls).toHaveLength(1)
          expect(progressCalls[0]).toEqual([50, 100, 'halfway'])
        },
      )
    })

    it('receives multiple calls as progress advances', async () => {
      const received: number[] = []
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'multi', input: z.object({}) }, async () => {
            const ctx = mcp.getContext()
            await ctx.reportProgress(25, 100)
            await ctx.reportProgress(50, 100)
            await ctx.reportProgress(100, 100)
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('multi', {}, {
            onProgress: (p) => { received.push(p) },
          })
          expect(received).toEqual([25, 50, 100])
        },
      )
    })
  })

  describe('samplingHandler', () => {
    it('is called when the server requests an LLM completion', async () => {
      const samplingFn = vi.fn<SamplingHandler>().mockResolvedValue({
        role: 'assistant',
        content: { type: 'text', text: 'Hello!' },
        model: 'test-model',
        stopReason: 'endTurn',
      })

      await withServer(
        (mcp) => {
          mcp.tool({ name: 'sampler', input: z.object({}) }, async () => {
            await mcp.getContext().sample({
              messages: [{ role: 'user', content: { type: 'text', text: 'say hi' } }],
            })
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('sampler', {})
          expect(samplingFn).toHaveBeenCalledOnce()
          const params = samplingFn.mock.calls[0][0]
          expect(params.messages).toHaveLength(1)
        },
        { handlers: { sampling: samplingFn } },
      )
    })

    it('the return value is forwarded back to the server as the completion result', async () => {
      let capturedResult: unknown
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'sampler', input: z.object({}) }, async () => {
            capturedResult = await mcp.getContext().sample({
              messages: [{ role: 'user', content: { type: 'text', text: 'say hi' } }],
            })
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('sampler', {})
          expect(capturedResult).toMatchObject({
            role: 'assistant',
            content: { type: 'text', text: 'fixed response' },
            model: 'mock-model',
          })
        },
        {
          handlers: {
            sampling: async () => ({
              role: 'assistant',
              content: { type: 'text', text: 'fixed response' },
              model: 'mock-model',
              stopReason: 'endTurn',
            }),
          },
        },
      )
    })
  })

  describe('elicitationHandler', () => {
    it('is called when the server requests structured user input', async () => {
      const elicitFn = vi.fn<ElicitationHandler>().mockResolvedValue({
        action: 'accept',
        content: { name: 'alice' },
      })

      await withServer(
        (mcp) => {
          mcp.tool({ name: 'elicitor', input: z.object({}) }, async () => {
            await mcp.getContext().elicit('What is your name?', {
              type: 'object',
              properties: { name: { type: 'string', title: 'Name' } },
              required: ['name'],
            })
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('elicitor', {})
          expect(elicitFn).toHaveBeenCalledOnce()
          const params = elicitFn.mock.calls[0][0]
          expect(params.message).toBe('What is your name?')
        },
        { handlers: { elicitation: elicitFn } },
      )
    })

    it('returning { action: "accept", content } sends the data back to the server', async () => {
      let capturedResult: unknown
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'elicitor', input: z.object({}) }, async () => {
            capturedResult = await mcp.getContext().elicit('Pick a name', {
              type: 'object',
              properties: { name: { type: 'string' } },
            })
            return 'done'
          })
        },
        async (client) => {
          await client.callTool('elicitor', {})
          expect(capturedResult).toMatchObject({
            action: 'accept',
            content: { name: 'bob' },
          })
        },
        {
          handlers: {
            elicitation: async () => ({ action: 'accept', content: { name: 'bob' } }),
          },
        },
      )
    })
  })

  describe('setLogLevel()', () => {
    it('resolves without error for any valid level', async () => {
      const levels: LoggingLevel[] = [
        'debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency',
      ]
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'noop', input: z.object({}) }, () => 'ok')
        },
        async (client) => {
          for (const level of levels) {
            await expect(client.setLogLevel(level)).resolves.toBeUndefined()
          }
        },
      )
    })

    it('suppresses logs below the configured level', async () => {
      const received: LogMessage[] = []
      await withServer(
        (mcp) => {
          mcp.tool({ name: 'logger', input: z.object({}) }, async () => {
            const ctx = mcp.getContext()
            await ctx.info('this should be suppressed')
            await ctx.error('this should arrive')
            return 'done'
          })
        },
        async (client) => {
          await client.setLogLevel('error')
          await client.callTool('logger', {})
          expect(received.some((m) => m.level === 'info')).toBe(false)
          expect(received.some((m) => m.level === 'error')).toBe(true)
        },
        { handlers: { log: (msg) => { received.push(msg) } } },
      )
    })
  })
})
