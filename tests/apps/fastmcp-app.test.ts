import { describe, it, expect } from 'vitest'
import { FastMCP, FastMCPApp, Column, Text, Button } from 'fastmcp-ts/server'
import { createUiTestClient } from '../helpers/createUiTestClient'
import { createTestClient } from '../helpers/createTestClient'

describe('Apps — FastMCPApp', () => {
  describe('visibility management', () => {
    it('entry-point tools are visible to the LLM and automatically linked to a ui:// resource', async () => {
      const app = new FastMCPApp({ name: 'my-app' })
      app.entrypoint(
        { name: 'show_dashboard', description: 'Show the dashboard' },
        () => Column({}, [Text('Dashboard')]),
      )

      const server = new FastMCP({ name: 'test' })
      server.addProvider(app)

      const { client, close } = await createUiTestClient(server)
      try {
        const tools = await client.listTools()
        const tool = tools.tools.find((t) => t.name === 'show_dashboard')
        expect(tool).toBeDefined()
        // Entry-point tools are automatically linked to a ui:// resource
        expect(tool!._meta?.ui?.resourceUri).toBeDefined()
        expect(tool!._meta?.ui?.resourceUri).toMatch(/^ui:\/\//)
      } finally {
        await close()
      }
    })

    it('backend tools are hidden from the LLM by default and only callable from within the rendered UI', async () => {
      const app = new FastMCPApp({ name: 'my-app' })
      app.entrypoint({ name: 'show', description: 'Show' }, () => Column())
      app.backendTool({ name: 'refresh', description: 'Refresh data' }, () => ({ rows: [] }))

      const server = new FastMCP({ name: 'test' })
      server.addProvider(app)

      const { client, close } = await createUiTestClient(server)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).not.toContain('refresh')

        // Still callable — the host bridges iframe callTool requests for app-only tools
        const result = await client.callTool({ name: 'refresh', arguments: {} })
        expect(result.isError).toBeFalsy()
      } finally {
        await close()
      }
    })

    it('a backend tool can opt in to LLM visibility without losing UI callability', async () => {
      const app = new FastMCPApp({ name: 'my-app' })
      app.backendTool(
        { name: 'search', description: 'Search', visibility: ['model', 'app'] },
        (args: { query: string }) => [args.query],
      )

      const server = new FastMCP({ name: 'test' })
      server.addProvider(app)

      const { client, close } = await createUiTestClient(server)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).toContain('search')

        // Callable as both model and app tool
        const result = await client.callTool({ name: 'search', arguments: { query: 'hello' } })
        expect(result.isError).toBeFalsy()
      } finally {
        await close()
      }
    })
  })

  describe('composition safety', () => {
    it('tool references in component trees resolve to the correct name via context injection', async () => {
      const app = new FastMCPApp({ name: 'my-app' })
      app.backendTool({ name: 'refresh', description: 'Refresh data' }, () => ({ rows: [] }))
      app.entrypoint({ name: 'show', description: 'Show' }, () =>
        // app.toolRef() resolves the internal name to the current external name via context
        Column({}, [Button({ label: 'Refresh', action: app.toolRef('refresh') })]),
      )

      const server = new FastMCP({ name: 'test' })
      server.addProvider(app)

      const { client, close } = await createUiTestClient(server)
      try {
        const result = await client.callTool({ name: 'show', arguments: {} })
        expect(result.isError).toBeFalsy()
        // Without a mount prefix the ref resolves to the original name
        expect(result.structuredContent).toMatchObject({
          children: [{ props: { action: 'refresh' } }],
        })
      } finally {
        await close()
      }
    })

    it('tool references survive namespace transforms applied during composition or mounting', async () => {
      const app = new FastMCPApp({ name: 'my-app' })
      app.backendTool({ name: 'refresh', description: 'Refresh data' }, () => ({ rows: [] }))
      app.entrypoint({ name: 'show', description: 'Show' }, () =>
        Column({}, [Button({ label: 'Refresh', action: app.toolRef('refresh') })]),
      )

      const parent = new FastMCP({ name: 'parent' })
      parent.mount(app.server, 'dash')

      const { client, close } = await createUiTestClient(parent)
      try {
        // Entry-point is now 'dash_show'; backend tool is now 'dash_refresh'
        const result = await client.callTool({ name: 'dash_show', arguments: {} })
        expect(result.isError).toBeFalsy()
        // toolRef resolved to the prefixed name thanks to context injection
        expect(result.structuredContent).toMatchObject({
          children: [{ props: { action: 'dash_refresh' } }],
        })
      } finally {
        await close()
      }
    })
  })

  describe('server integration', () => {
    it('a FastMCPApp instance can be registered as a provider on a FastMCP server', async () => {
      const app = new FastMCPApp({ name: 'my-app' })
      app.entrypoint({ name: 'open', description: 'Open' }, () => Column())

      const server = new FastMCP({ name: 'test' })
      server.addProvider(app)

      const { client, close } = await createUiTestClient(server)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).toContain('open')
      } finally {
        await close()
      }
    })

    it('multiple FastMCPApp instances can be composed on the same server without conflicts', async () => {
      const appA = new FastMCPApp({ name: 'app-a' })
      appA.entrypoint({ name: 'open_a', description: 'Open A' }, () => Column())

      const appB = new FastMCPApp({ name: 'app-b' })
      appB.entrypoint({ name: 'open_b', description: 'Open B' }, () => Column())

      const server = new FastMCP({ name: 'test' })
      server.addProvider(appA)
      server.addProvider(appB)

      const { client, close } = await createUiTestClient(server)
      try {
        const tools = await client.listTools()
        const names = tools.tools.map((t) => t.name)
        expect(names).toContain('open_a')
        expect(names).toContain('open_b')
      } finally {
        await close()
      }
    })

    it('gracefully degrades when hosted on a server whose client does not advertise UI support', async () => {
      const app = new FastMCPApp({ name: 'my-app' })
      app.entrypoint({ name: 'open', description: 'Open' }, () => Column({}, [Text('Hello')]))

      const server = new FastMCP({ name: 'test' })
      server.addProvider(app)

      // Connect without UI capability
      const { client, close } = await createTestClient(server)
      try {
        const result = await client.callTool({ name: 'open', arguments: {} })
        expect(result.isError).toBeFalsy()
        // Graceful degradation: structuredContent is suppressed, plain text returned
        expect(result.structuredContent).toBeUndefined()
        expect(result.content[0].type).toBe('text')
      } finally {
        await close()
      }
    })
  })
})
