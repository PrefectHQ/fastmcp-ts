import { describe, it } from 'vitest'

describe('Apps', () => {
  describe('ui:// resources', () => {
    it.todo('ui:// resources appear in resources/list with mimeType text/html;profile=mcp-app')
    it.todo('resources/read returns the HTML content for a ui:// URI')
    it.todo('_meta.ui on a resource carries CSP policy, browser permissions, domain, and prefersBorder')
    it.todo('a server without ui:// resources does not advertise the io.modelcontextprotocol/ui extension')
  })

  describe('capability negotiation', () => {
    it.todo('the server advertises io.modelcontextprotocol/ui in capabilities.extensions during initialize')
    it.todo('when the host does not advertise UI support, tools linked to ui:// resources remain callable as text-only tools')
    it.todo('graceful degradation: structuredContent is omitted and a plain text fallback is returned')
  })

  describe('tool-UI binding', () => {
    it.todo('a tool linked to a ui:// resource via _meta.ui.resourceUri renders a UI when invoked by a supporting host')
    it.todo('the ui:// resource URI is automatically derived from the tool name when not provided explicitly')
    it.todo('invoking the tool returns structured content the host can render as a UI')
    it.todo('the UI component tree is serialised to JSON and delivered via structuredContent')
  })

  describe('tool visibility', () => {
    it.todo('a tool with visibility ["model"] appears in tools/list and is callable by the LLM')
    it.todo('a tool with visibility ["app"] is absent from tools/list and is not callable by the LLM')
    it.todo('a tool with visibility ["model", "app"] is callable by both the LLM and the rendered UI')
    it.todo('an app-only tool can be invoked from within the iframe via the host postMessage bridge')
  })

  describe('host context', () => {
    it.todo('the host delivers HostContext to the iframe on init including theme, CSS custom properties, and displayMode')
    it.todo('HostContext includes containerDimensions, locale, timeZone, platform, and deviceCapabilities')
    it.todo('the View can request a display mode change via ui/request-display-mode')
    it.todo('the host notifies the View of container resize events')
  })

  describe('bidirectional communication', () => {
    it.todo('the rendered UI can invoke server tools via the host postMessage bridge')
    it.todo('the result of a UI-initiated tool call is delivered back to the UI')
    it.todo('the View can inject a user turn into the conversation via ui/message')
    it.todo('the View can push structured state to model context via ui/update-model-context')
    it.todo('app-provided tools registered by the View are callable by the host or agent for the iframe lifetime')
    it.todo('app-provided tools are removed when the iframe is torn down')
  })

  describe('component model', () => {
    it.todo('layout components (Column, Row, Grid) serialise correctly')
    it.todo('data display components (Table, Badge, Text) serialise correctly')
    it.todo('chart components (Bar, Line, Area, Pie) serialise correctly')
    it.todo('form components (Input, Select, Button) serialise correctly')
    it.todo('conditional rendering (If/Elif/Else) serialises correctly')
    it.todo('dynamic list rendering (ForEach) serialises correctly')
    it.todo('client-side reactive state (Rx) evaluates without a server round-trip')
  })
})
