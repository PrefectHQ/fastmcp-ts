import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  FastMCP,
  Column, Row, Grid,
  Text, Badge, Table,
  Bar, Line, Area, Pie,
  Input, Select, Button,
  If, ForEach, Rx,
} from 'fastmcp-ts/server'
import { createTestClient } from '../helpers/createTestClient'
import { createUiTestClient } from '../helpers/createUiTestClient'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUiServer() {
  const mcp = new FastMCP({ name: 'test' })
  mcp.resource(
    { uri: 'ui://test-app/view', mimeType: 'text/html;profile=mcp-app' },
    () => '<h1>Test App</h1>',
  )
  mcp.tool(
    {
      name: 'show_dashboard',
      description: 'Show the dashboard',
      ui: { resourceUri: 'ui://test-app/view' },
    },
    () => Column({}, [Text('Dashboard')]),
  )
  return mcp
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Apps', () => {
  describe('ui:// resources', () => {
    it('ui:// resources appear in resources/list with mimeType text/html;profile=mcp-app', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource(
        { uri: 'ui://my-app/view', mimeType: 'text/html;profile=mcp-app' },
        () => '<h1>Hello</h1>',
      )
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.listResources()
        const ui = result.resources.find((r) => r.uri === 'ui://my-app/view')
        expect(ui).toBeDefined()
        expect(ui!.mimeType).toBe('text/html;profile=mcp-app')
      } finally {
        await close()
      }
    })

    it('resources/read returns the HTML content for a ui:// URI', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource(
        { uri: 'ui://my-app/view', mimeType: 'text/html;profile=mcp-app' },
        () => '<h1>Hello</h1>',
      )
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.readResource({ uri: 'ui://my-app/view' })
        expect(result.contents[0]).toMatchObject({
          uri: 'ui://my-app/view',
          mimeType: 'text/html;profile=mcp-app',
          text: '<h1>Hello</h1>',
        })
      } finally {
        await close()
      }
    })

    it('_meta.ui on a resource carries CSP policy, browser permissions, domain, and prefersBorder', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource(
        {
          uri: 'ui://my-app/view',
          mimeType: 'text/html;profile=mcp-app',
          ui: {
            csp: { connectDomains: ['api.example.com'] },
            permissions: ['camera'],
            domain: 'my-app.example.com',
            prefersBorder: false,
          },
        },
        () => '<h1>Hello</h1>',
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const result = await client.listResources()
        const ui = result.resources.find((r) => r.uri === 'ui://my-app/view')!
        expect(ui._meta?.ui).toMatchObject({
          csp: { connectDomains: ['api.example.com'] },
          permissions: ['camera'],
          domain: 'my-app.example.com',
          prefersBorder: false,
        })
      } finally {
        await close()
      }
    })

    it('a server without ui:// resources does not advertise the io.modelcontextprotocol/ui extension', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool({ name: 'greet', description: 'Say hello' }, () => 'hello')
      const { client, close } = await createTestClient(mcp)
      try {
        const caps = client.getServerCapabilities()
        expect(caps?.extensions?.['io.modelcontextprotocol/ui']).toBeUndefined()
      } finally {
        await close()
      }
    })
  })

  describe('capability negotiation', () => {
    it('the server advertises io.modelcontextprotocol/ui in capabilities.extensions during initialize', async () => {
      const mcp = makeUiServer()
      const { client, close } = await createUiTestClient(mcp)
      try {
        const caps = client.getServerCapabilities()
        expect(caps?.extensions?.['io.modelcontextprotocol/ui']).toBeDefined()
      } finally {
        await close()
      }
    })

    it('when the host does not advertise UI support, tools linked to ui:// resources remain callable as text-only tools', async () => {
      const mcp = makeUiServer()
      // Connect without UI capability
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'show_dashboard', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.content.length).toBeGreaterThan(0)
        expect(result.content[0].type).toBe('text')
      } finally {
        await close()
      }
    })

    it('graceful degradation: structuredContent is omitted and a plain text fallback is returned', async () => {
      const mcp = makeUiServer()
      const { client, close } = await createTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'show_dashboard', arguments: {} })
        // Non-UI clients must not receive structuredContent — that would push
        // the raw component tree into the LLM context with no rendering path.
        expect(result.structuredContent).toBeUndefined()
      } finally {
        await close()
      }
    })
  })

  describe('tool-UI binding', () => {
    it('a tool linked to a ui:// resource via _meta.ui.resourceUri renders a UI when invoked by a supporting host', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource(
        { uri: 'ui://my-app/view', mimeType: 'text/html;profile=mcp-app' },
        () => '<h1>Hello</h1>',
      )
      mcp.tool(
        { name: 'open_app', description: 'Open app', ui: { resourceUri: 'ui://my-app/view' } },
        () => Column({}, [Text('Hello')]),
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const tools = await client.listTools()
        const tool = tools.tools.find((t) => t.name === 'open_app')!
        expect(tool._meta?.ui?.resourceUri).toBe('ui://my-app/view')
      } finally {
        await close()
      }
    })

    it('the ui:// resource URI is automatically derived from the tool name when not provided explicitly', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'show_dashboard', description: 'Show dashboard', ui: {} },
        () => Column({}, [Text('Dashboard')]),
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const tools = await client.listTools()
        const tool = tools.tools.find((t) => t.name === 'show_dashboard')!
        expect(tool._meta?.ui?.resourceUri).toBe('ui://show_dashboard')
      } finally {
        await close()
      }
    })

    it('invoking the tool returns structured content the host can render as a UI', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'show_dashboard', description: 'Show dashboard', ui: {} },
        () => Column({}, [Text('Dashboard')]),
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'show_dashboard', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toBeDefined()
      } finally {
        await close()
      }
    })

    it('the UI component tree is serialised to JSON and delivered via structuredContent', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'show_dashboard', description: 'Show dashboard', ui: {} },
        () => Column({}, [Text('Hello')]),
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'show_dashboard', arguments: {} })
        expect(result.structuredContent).toEqual({
          type: 'column',
          children: [{ type: 'text', props: { content: 'Hello' } }],
        })
      } finally {
        await close()
      }
    })
  })

  describe('tool visibility', () => {
    it('a tool with visibility ["model"] appears in tools/list and is callable by the LLM', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'model_tool', description: 'Model tool', ui: { visibility: ['model'] } },
        () => 'result',
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).toContain('model_tool')
        const result = await client.callTool({ name: 'model_tool', arguments: {} })
        expect(result.isError).toBeFalsy()
      } finally {
        await close()
      }
    })

    it('a tool with visibility ["app"] is absent from tools/list', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'app_tool', description: 'App-only tool', ui: { visibility: ['app'] } },
        () => 'result',
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).not.toContain('app_tool')
      } finally {
        await close()
      }
    })

    it('a tool with visibility ["model", "app"] is callable by both the LLM and the rendered UI', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'dual_tool', description: 'Dual tool', ui: { visibility: ['model', 'app'] } },
        () => 'result',
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const tools = await client.listTools()
        expect(tools.tools.map((t) => t.name)).toContain('dual_tool')
        const result = await client.callTool({ name: 'dual_tool', arguments: {} })
        expect(result.isError).toBeFalsy()
      } finally {
        await close()
      }
    })

    it('an app-only tool can be invoked from within the iframe via the host postMessage bridge', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'backend_action', description: 'Backend action', ui: { visibility: ['app'] } },
        () => ({ status: 'ok' }),
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        // The host bridges iframe tool calls via callTool — app-only tools must still be invocable
        const result = await client.callTool({ name: 'backend_action', arguments: {} })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toEqual({ status: 'ok' })
      } finally {
        await close()
      }
    })
  })

  describe('bidirectional communication', () => {
    it('the rendered UI can invoke server tools via the host postMessage bridge', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'fetch_data', description: 'Fetch data', ui: { visibility: ['app'] } },
        () => ({ rows: [1, 2, 3] }),
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        // In the test environment the postMessage bridge is simulated via direct callTool
        const result = await client.callTool({ name: 'fetch_data', arguments: {} })
        expect(result.isError).toBeFalsy()
      } finally {
        await close()
      }
    })

    it('the result of a UI-initiated tool call is delivered back to the UI', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.tool(
        { name: 'compute', description: 'Compute', ui: { visibility: ['app'] } },
        () => ({ value: 42 }),
      )
      const { client, close } = await createUiTestClient(mcp)
      try {
        const result = await client.callTool({ name: 'compute', arguments: {} })
        expect(result.structuredContent).toEqual({ value: 42 })
      } finally {
        await close()
      }
    })
  })

  describe('component model', () => {
    it('layout components (Column, Row, Grid) serialise correctly', () => {
      expect(Column()).toEqual({ type: 'column' })
      expect(Column({ gap: 4 }, [Text('hi')])).toEqual({
        type: 'column',
        props: { gap: 4 },
        children: [{ type: 'text', props: { content: 'hi' } }],
      })
      expect(Row({ align: 'center' }, [Text('left'), Text('right')])).toEqual({
        type: 'row',
        props: { align: 'center' },
        children: [
          { type: 'text', props: { content: 'left' } },
          { type: 'text', props: { content: 'right' } },
        ],
      })
      expect(Grid({ columns: 3 }, [Text('a'), Text('b'), Text('c')])).toEqual({
        type: 'grid',
        props: { columns: 3 },
        children: [
          { type: 'text', props: { content: 'a' } },
          { type: 'text', props: { content: 'b' } },
          { type: 'text', props: { content: 'c' } },
        ],
      })
    })

    it('data display components (Table, Badge, Text) serialise correctly', () => {
      expect(Text('Hello')).toEqual({ type: 'text', props: { content: 'Hello' } })
      expect(Text('Title', { variant: 'heading' })).toEqual({
        type: 'text',
        props: { content: 'Title', variant: 'heading' },
      })
      expect(Badge('Success')).toEqual({ type: 'badge', props: { text: 'Success' } })
      expect(Badge('Warning', { color: 'yellow' })).toEqual({
        type: 'badge',
        props: { text: 'Warning', color: 'yellow' },
      })
      expect(Table({ columns: ['Name', 'Age'], rows: [['Alice', '30'], ['Bob', '25']] })).toEqual({
        type: 'table',
        props: { columns: ['Name', 'Age'], rows: [['Alice', '30'], ['Bob', '25']] },
      })
    })

    it('chart components (Bar, Line, Area, Pie) serialise correctly', () => {
      const data = [{ month: 'Jan', revenue: 100 }, { month: 'Feb', revenue: 200 }]
      expect(Bar({ data, xKey: 'month', yKey: 'revenue' })).toEqual({
        type: 'chart-bar',
        props: { data, xKey: 'month', yKey: 'revenue' },
      })
      expect(Line({ data, xKey: 'month', yKey: 'revenue' })).toEqual({
        type: 'chart-line',
        props: { data, xKey: 'month', yKey: 'revenue' },
      })
      expect(Area({ data, xKey: 'month', yKey: 'revenue' })).toEqual({
        type: 'chart-area',
        props: { data, xKey: 'month', yKey: 'revenue' },
      })
      expect(Pie({ data, labelKey: 'month', valueKey: 'revenue' })).toEqual({
        type: 'chart-pie',
        props: { data, labelKey: 'month', valueKey: 'revenue' },
      })
    })

    it('form components (Input, Select, Button) serialise correctly', () => {
      expect(Input({ name: 'email', label: 'Email', type: 'email' })).toEqual({
        type: 'input',
        props: { name: 'email', label: 'Email', type: 'email' },
      })
      expect(Select({ name: 'color', label: 'Colour', options: ['Red', 'Green', 'Blue'] })).toEqual({
        type: 'select',
        props: { name: 'color', label: 'Colour', options: ['Red', 'Green', 'Blue'] },
      })
      expect(Button({ label: 'Submit', action: 'submit_form' })).toEqual({
        type: 'button',
        props: { label: 'Submit', action: 'submit_form' },
      })
    })

    it('conditional rendering (If/Elif/Else) serialises correctly', () => {
      // Binary conditional
      expect(If('x > 0', Text('positive'))).toEqual({
        type: 'if',
        branches: [{ condition: 'x > 0', node: { type: 'text', props: { content: 'positive' } } }],
      })
      // With else
      expect(If('x > 0', Text('positive'), Text('non-positive'))).toEqual({
        type: 'if',
        branches: [{ condition: 'x > 0', node: { type: 'text', props: { content: 'positive' } } }],
        fallback: { type: 'text', props: { content: 'non-positive' } },
      })
      // Multi-branch via builder
      expect(
        If('x > 0', Text('positive'))
          .elif('x < 0', Text('negative'))
          .else(Text('zero')),
      ).toEqual({
        type: 'if',
        branches: [
          { condition: 'x > 0', node: { type: 'text', props: { content: 'positive' } } },
          { condition: 'x < 0', node: { type: 'text', props: { content: 'negative' } } },
        ],
        fallback: { type: 'text', props: { content: 'zero' } },
      })
    })

    it('dynamic list rendering (ForEach) serialises correctly', () => {
      const template = Row({}, [Text(Rx('$item.name')), Text(Rx('$item.age'))])
      expect(ForEach('users', template)).toEqual({
        type: 'foreach',
        props: { items: 'users' },
        children: [template],
      })
    })

    it('client-side reactive state (Rx) serialises to an evaluable descriptor', () => {
      // Rx serialises to a descriptor that the View evaluates without a server round-trip
      expect(Rx('user.name')).toEqual({ type: 'rx', props: { expression: 'user.name' } })
      expect(Rx('items.length > 0')).toEqual({ type: 'rx', props: { expression: 'items.length > 0' } })
      // Rx nodes can be embedded as prop values in other components
      expect(Text(Rx('greeting'))).toEqual({
        type: 'text',
        props: { content: { type: 'rx', props: { expression: 'greeting' } } },
      })
    })
  })
})
