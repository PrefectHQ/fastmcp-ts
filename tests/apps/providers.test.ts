import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { FastMCP, Approval, Choice, FileUpload, FormInput } from 'fastmcp-ts/server'
import { createUiTestClient } from '../helpers/createUiTestClient'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withProvider<T>(
  provider: { server: FastMCP } | FastMCP,
  fn: (client: Awaited<ReturnType<typeof createUiTestClient>>['client']) => Promise<T>,
): Promise<T> {
  const inner = 'server' in provider ? provider.server : provider
  const server = new FastMCP({ name: 'test' })
  server.addProvider(inner as FastMCP)
  const { client, close } = await createUiTestClient(server)
  try {
    return await fn(client)
  } finally {
    await close()
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Apps — Built-in Providers', () => {
  describe('Approval', () => {
    it('presents a confirm/deny UI card to the user', async () => {
      const approval = new Approval()
      await withProvider(approval, async (client) => {
        const result = await client.callTool({
          name: 'approval_request',
          arguments: { message: 'Delete this file?' },
        })
        expect(result.isError).toBeFalsy()
        // Returns a UI component tree with confirm and deny affordances
        expect(result.structuredContent).toMatchObject({ type: expect.any(String) })
      })
    })

    it("the decision is returned to the View for injection into the conversation", async () => {
      // The approval confirm/deny tools are backend-only (not exposed to the LLM).
      // The View calls them via the host bridge and uses the result to inject a
      // conversation turn via app.sendMessage() — that part is a View SDK concern.
      const approval = new Approval()
      await withProvider(approval, async (client) => {
        const tools = await client.listTools()
        const names = tools.tools.map((t) => t.name)
        // approval_request is the LLM-visible entry-point; the decision tools are backend-only
        expect(names).toContain('approval_request')
        expect(names).not.toContain('approval_confirm')
        expect(names).not.toContain('approval_deny')
      })
    })

    it('returns the decision to the requesting tool', async () => {
      const approval = new Approval()
      await withProvider(approval, async (client) => {
        const confirmed = await client.callTool({ name: 'approval_confirm', arguments: {} })
        expect(confirmed.structuredContent).toEqual({ decision: 'approved' })

        const denied = await client.callTool({ name: 'approval_deny', arguments: {} })
        expect(denied.structuredContent).toEqual({ decision: 'denied' })
      })
    })
  })

  describe('Choice', () => {
    it('presents a list of clickable options for the user to select from', async () => {
      const choice = new Choice()
      await withProvider(choice, async (client) => {
        const result = await client.callTool({
          name: 'choice_present',
          arguments: { question: 'Pick a colour', options: ['Red', 'Green', 'Blue'] },
        })
        expect(result.isError).toBeFalsy()
        // Component tree contains one button per option
        const tree = result.structuredContent as { children: Array<{ props: { label: string } }> }
        const labels = tree.children.map((c) => c.props.label)
        expect(labels).toContain('Red')
        expect(labels).toContain('Green')
        expect(labels).toContain('Blue')
      })
    })

    it('returns the selected option to the requesting tool', async () => {
      const choice = new Choice()
      await withProvider(choice, async (client) => {
        const result = await client.callTool({
          name: 'choice_select',
          arguments: { option: 'Green' },
        })
        expect(result.structuredContent).toEqual({ selected: 'Green' })
      })
    })
  })

  describe('FileUpload', () => {
    it('presents a drag-and-drop file picker UI', async () => {
      const upload = new FileUpload()
      await withProvider(upload, async (client) => {
        const result = await client.callTool({
          name: 'file_upload_open',
          arguments: { prompt: 'Upload a CSV file' },
        })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toMatchObject({ type: expect.any(String) })
      })
    })

    it('stores uploaded files server-side, bypassing the LLM context window', async () => {
      const upload = new FileUpload()
      await withProvider(upload, async (client) => {
        const data = Buffer.from('name,age\nAlice,30').toString('base64')
        const result = await client.callTool({
          name: 'file_upload_submit',
          arguments: { name: 'data.csv', mimeType: 'text/csv', data },
        })

        expect(result.isError).toBeFalsy()
        const payload = result.structuredContent as { handle: string; uri: string }
        expect(typeof payload.handle).toBe('string')
        expect(payload.uri).toMatch(/^ui:\/\/files\//)

        // Raw file bytes must NOT appear in the tool result — only the handle does
        const text = (result.content[0] as { text: string }).text
        expect(text).not.toContain('name,age')
      })
    })

    it('returns file content and metadata via a ui:// resource', async () => {
      const upload = new FileUpload()
      await withProvider(upload, async (client) => {
        const original = 'hello world'
        const data = Buffer.from(original).toString('base64')
        const uploadResult = await client.callTool({
          name: 'file_upload_submit',
          arguments: { name: 'test.txt', mimeType: 'text/plain', data },
        })

        const { uri } = uploadResult.structuredContent as { handle: string; uri: string }

        // File is accessible via standard MCP resource read — no extra tool needed
        const resource = await client.readResource({ uri })
        expect(resource.contents[0]).toMatchObject({
          uri,
          mimeType: 'text/plain',
          text: original,
        })
      })
    })
  })

  describe('FormInput', () => {
    it('generates a form UI from a Standard Schema validator', async () => {
      const schema = z.object({ name: z.string(), age: z.number() })
      const form = new FormInput({ name: 'collect_info', description: 'Collect user info', schema })
      await withProvider(form, async (client) => {
        const result = await client.callTool({ name: 'collect_info', arguments: {} })
        expect(result.isError).toBeFalsy()
        // Component tree is a form with fields derived from the schema
        const tree = result.structuredContent as {
          type: string
          children: Array<{ type: string; props: { name: string } }>
        }
        expect(tree.type).toMatch(/column|form/)
        const fieldNames = tree.children
          .filter((c) => c.type === 'input' || c.type === 'select')
          .map((c) => c.props.name)
        expect(fieldNames).toContain('name')
        expect(fieldNames).toContain('age')
      })
    })

    it('returns validated form data to the requesting tool on submission', async () => {
      const schema = z.object({ name: z.string(), age: z.number() })
      const form = new FormInput({ name: 'collect_info', description: 'Collect user info', schema })
      await withProvider(form, async (client) => {
        const result = await client.callTool({
          name: 'collect_info_submit',
          arguments: { data: { name: 'Alice', age: 30 } },
        })
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toEqual({ name: 'Alice', age: 30 })
      })
    })

    it('returns field-level validation errors when the user submits invalid data', async () => {
      const schema = z.object({ name: z.string(), age: z.number() })
      const form = new FormInput({ name: 'collect_info', description: 'Collect user info', schema })
      await withProvider(form, async (client) => {
        const result = await client.callTool({
          name: 'collect_info_submit',
          arguments: { data: { name: '', age: 'not-a-number' } },
        })
        // Validation failure is not a tool error — it returns structured errors so
        // the View can display them inline as field-level hints
        expect(result.isError).toBeFalsy()
        const payload = result.structuredContent as { errors: Record<string, string> }
        expect(payload.errors).toBeDefined()
        expect(payload.errors.age).toEqual(expect.any(String))
      })
    })
  })
})
