import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { FastMCP } from 'fastmcp-ts/server'
import { resolveTaskConfig } from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup(mcp: FastMCP) {
  const { client, close } = await createTestClient(mcp)
  return { client, close }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Server — Tasks', () => {
  // -------------------------------------------------------------------------
  // resolveTaskConfig — pure unit tests
  // -------------------------------------------------------------------------

  describe('resolveTaskConfig', () => {
    it('undefined → forbidden / default pollInterval', () => {
      expect(resolveTaskConfig(undefined)).toEqual({ mode: 'forbidden', pollInterval: 5000 })
    })

    it('false → forbidden / default pollInterval', () => {
      expect(resolveTaskConfig(false)).toEqual({ mode: 'forbidden', pollInterval: 5000 })
    })

    it('true → optional / default pollInterval', () => {
      expect(resolveTaskConfig(true)).toEqual({ mode: 'optional', pollInterval: 5000 })
    })

    it('{ mode: required } → required / default pollInterval', () => {
      expect(resolveTaskConfig({ mode: 'required' })).toEqual({ mode: 'required', pollInterval: 5000 })
    })

    it('{ pollInterval: 2000 } → optional / custom pollInterval', () => {
      expect(resolveTaskConfig({ pollInterval: 2000 })).toEqual({ mode: 'optional', pollInterval: 2000 })
    })

    it('{ mode: required, pollInterval: 1000 } → fully explicit', () => {
      expect(resolveTaskConfig({ mode: 'required', pollInterval: 1000 })).toEqual({
        mode: 'required',
        pollInterval: 1000,
      })
    })
  })

  // -------------------------------------------------------------------------
  // Capability advertisement
  // -------------------------------------------------------------------------

  describe('capability advertisement', () => {
    it('advertises tasks capability when a tool has task: true', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'slow', description: 'slow tool', task: true }, async () => 'done')
      const { client, close } = await setup(mcp)
      try {
        const caps = client.getServerCapabilities()
        expect(caps?.tasks).toBeDefined()
        expect((caps?.tasks as Record<string, unknown>)?.requests).toBeDefined()
      } finally {
        await close()
      }
    })

    it('advertises tasks capability when a tool has task: { mode: required }', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'required', description: 'required tool', task: { mode: 'required' } }, async () => 'done')
      const { client, close } = await setup(mcp)
      try {
        expect(client.getServerCapabilities()?.tasks).toBeDefined()
      } finally {
        await close()
      }
    })

    it('does not advertise tasks capability when no tool uses task config', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'fast', description: 'fast tool' }, () => 'done')
      const { client, close } = await setup(mcp)
      try {
        expect(client.getServerCapabilities()?.tasks).toBeUndefined()
      } finally {
        await close()
      }
    })

    it('does not advertise tasks capability when all tools have task: false', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'sync', description: 'sync only', task: false }, () => 'done')
      const { client, close } = await setup(mcp)
      try {
        expect(client.getServerCapabilities()?.tasks).toBeUndefined()
      } finally {
        await close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Task execution — happy path
  // -------------------------------------------------------------------------

  describe('task execution — happy path', () => {
    it('returns CreateTaskResult immediately when client requests task execution', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'slow', description: 'slow', task: true }, async () => 'done')
      const { client, close } = await setup(mcp)
      try {
        const stream = client.experimental.tasks.callToolStream(
          { name: 'slow', arguments: {} },
          undefined,
          { task: { ttl: 60_000 } },
        )
        const first = await stream.next()
        expect(first.done).toBe(false)
        expect(first.value?.type).toBe('taskCreated')
        if (first.value?.type === 'taskCreated') {
          expect(first.value.task.status).toBe('working')
          expect(typeof first.value.task.taskId).toBe('string')
          expect(first.value.task.taskId.length).toBeGreaterThan(0)
        }
        for await (const _ of stream) { /* drain */ }
      } finally {
        await close()
      }
    })

    it('task result matches the synchronous return value', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'greet', description: 'greet', input: z.object({ name: z.string() }), task: true },
        async ({ name }) => `hello ${name}`,
      )
      const { client, close } = await setup(mcp)
      try {
        let result: unknown
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'greet', arguments: { name: 'ada' } },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'result') result = msg.result
        }
        expect((result as { content: { type: string; text: string }[] })?.content[0]).toMatchObject({
          type: 'text',
          text: 'hello ada',
        })
      } finally {
        await close()
      }
    })

    it('task transitions to completed status after the handler resolves', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'slow', description: 'slow', task: true }, async () => 'done')
      const { client, close } = await setup(mcp)
      try {
        let taskId: string | undefined
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'slow', arguments: {} },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'taskCreated') taskId = msg.task.taskId
        }
        const status = await client.experimental.tasks.getTask(taskId!)
        expect(status.status).toBe('completed')
      } finally {
        await close()
      }
    })

    it('respects the pollInterval configured on the tool', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'slow', description: 'slow', task: { pollInterval: 1234 } }, async () => 'done')
      const { client, close } = await setup(mcp)
      try {
        const stream = client.experimental.tasks.callToolStream(
          { name: 'slow', arguments: {} },
          undefined,
          { task: {} },
        )
        const first = await stream.next()
        if (first.value?.type === 'taskCreated') {
          expect(first.value.task.pollInterval).toBe(1234)
        }
        for await (const _ of stream) { /* drain */ }
      } finally {
        await close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Task execution — failure path
  // -------------------------------------------------------------------------

  describe('task execution — failure path', () => {
    it('task transitions to failed status when the handler throws', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'boom', description: 'boom', task: true }, async () => {
        throw new Error('it exploded')
      })
      const { client, close } = await setup(mcp)
      try {
        let taskId: string | undefined
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'boom', arguments: {} },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'taskCreated') taskId = msg.task.taskId
        }
        const status = await client.experimental.tasks.getTask(taskId!)
        expect(status.status).toBe('failed')
      } finally {
        await close()
      }
    })

    it('failed task yields an error message in the stream', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'boom', description: 'boom', task: true }, async () => {
        throw new Error('it exploded')
      })
      const { client, close } = await setup(mcp)
      try {
        let hadError = false
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'boom', arguments: {} },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'error') hadError = true
        }
        expect(hadError).toBe(true)
      } finally {
        await close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Mode enforcement
  // -------------------------------------------------------------------------

  describe('mode enforcement', () => {
    it('forbidden (default): task request yields an error message', async () => {
      const mcp = new FastMCP({ name: 'test' })
      // Need at least one task-enabled tool so the server advertises tasks capability
      mcp.tool({ name: 'enabler', description: 'enables tasks', task: true }, async () => 'ok')
      mcp.tool({ name: 'synconly', description: 'sync only' }, () => 'sync')
      const { client, close } = await setup(mcp)
      try {
        let hadError = false
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'synconly', arguments: {} },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'error') hadError = true
        }
        expect(hadError).toBe(true)
      } finally {
        await close()
      }
    })

    it('forbidden (explicit task: false): task request yields an error message', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'enabler', description: 'enables tasks', task: true }, async () => 'ok')
      mcp.tool({ name: 'nosync', description: 'no sync', task: false }, () => 'sync')
      const { client, close } = await setup(mcp)
      try {
        let hadError = false
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'nosync', arguments: {} },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'error') hadError = true
        }
        expect(hadError).toBe(true)
      } finally {
        await close()
      }
    })

    it('required: synchronous call is rejected', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'taskonly', description: 'task only', task: { mode: 'required' } }, async () => 'ok')
      const { client, close } = await setup(mcp)
      try {
        await expect(
          client.callTool({ name: 'taskonly', arguments: {} }),
        ).rejects.toThrow()
      } finally {
        await close()
      }
    })

    it('required: task request succeeds', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'taskonly', description: 'task only', task: { mode: 'required' } }, async () => 'done')
      const { client, close } = await setup(mcp)
      try {
        let result: unknown
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'taskonly', arguments: {} },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'result') result = msg.result
        }
        expect((result as { isError?: boolean })?.isError).toBeFalsy()
      } finally {
        await close()
      }
    })

    it('optional (task: true): synchronous call works normally', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'flex', description: 'flexible', task: true }, async () => 'flexible')
      const { client, close } = await setup(mcp)
      try {
        const result = await client.callTool({ name: 'flex', arguments: {} })
        expect(result.content[0]).toMatchObject({ type: 'text', text: 'flexible' })
      } finally {
        await close()
      }
    })

    it('optional (task: true): task call works', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'flex', description: 'flexible', task: true }, async () => 'flexible')
      const { client, close } = await setup(mcp)
      try {
        let result: unknown
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'flex', arguments: {} },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'result') result = msg.result
        }
        expect((result as { content: { type: string; text: string }[] })?.content[0]).toMatchObject({
          type: 'text',
          text: 'flexible',
        })
      } finally {
        await close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe('input validation', () => {
    it('validates input before creating the task — bad input yields an error message', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'typed', description: 'typed', input: z.object({ n: z.number() }), task: true },
        async ({ n }) => n * 2,
      )
      const { client, close } = await setup(mcp)
      try {
        let hadError = false
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'typed', arguments: { n: 'not-a-number' } },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'error') hadError = true
        }
        expect(hadError).toBe(true)
      } finally {
        await close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Timeout bypass
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('tool timeout does not interrupt task execution', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'slow', description: 'slow', timeout: 50, task: true },
        async () => {
          await new Promise<void>((r) => setTimeout(r, 200))
          return 'survived'
        },
      )
      const { client, close } = await setup(mcp)
      try {
        let result: unknown
        for await (const msg of client.experimental.tasks.callToolStream(
          { name: 'slow', arguments: {} },
          undefined,
          { task: {} },
        )) {
          if (msg.type === 'result') result = msg.result
        }
        expect((result as { content: { text: string }[] })?.content[0]?.text).toBe('survived')
      } finally {
        await close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  describe('tasks/cancel', () => {
    it('cancels a running task and sets its status to cancelled', async () => {
      const mcp = new FastMCP({ name: 'test' })
      let handlerStarted = false
      mcp.tool(
        { name: 'long', description: 'long running', task: true },
        async () => {
          handlerStarted = true
          await new Promise<void>((r) => setTimeout(r, 10_000))
          return 'never'
        },
      )
      const { client, close } = await setup(mcp)
      try {
        const stream = client.experimental.tasks.callToolStream(
          { name: 'long', arguments: {} },
          undefined,
          { task: {} },
        )

        const first = await stream.next()
        expect(first.value?.type).toBe('taskCreated')
        const taskId = (first.value as { type: 'taskCreated'; task: { taskId: string } }).task.taskId

        // Wait for the handler to actually start before cancelling
        await vi.waitFor(() => expect(handlerStarted).toBe(true), { timeout: 1000 })

        const cancelResult = await client.experimental.tasks.cancelTask(taskId)
        expect(cancelResult.status).toBe('cancelled')

        await stream.return(undefined) // clean up generator
      } finally {
        await close()
      }
    })
  })

  // -------------------------------------------------------------------------
  // FastMCPOptions.tasks — explicit server-level configuration
  // -------------------------------------------------------------------------

  describe('FastMCPOptions.tasks', () => {
    it('tasks: true enables task support even with no task-annotated tools', async () => {
      const mcp = new FastMCP({ name: 'test', tasks: true })
      mcp.tool({ name: 'regular', description: 'regular' }, () => 'ok')
      const { client, close } = await setup(mcp)
      try {
        expect(client.getServerCapabilities()?.tasks).toBeDefined()
      } finally {
        await close()
      }
    })
  })
})
