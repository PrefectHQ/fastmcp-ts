import { describe, it } from 'vitest'

describe('Apps', () => {
  describe('tool-UI binding', () => {
    it.todo('a tool declared with app: true is associated with a UI resource')
    it.todo('the UI resource URI is automatically configured when not provided explicitly')
    it.todo('invoking the tool returns structured content the host can render as a UI')
    it.todo('the UI component tree is serialised to JSON and delivered via structuredContent')
  })

  describe('bidirectional communication', () => {
    it.todo('the rendered UI can invoke server tools via the host postMessage bridge')
    it.todo('the result of a UI-initiated tool call is delivered back to the UI')
    it.todo('UI state updates are reflected without a full round-trip to the server')
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
