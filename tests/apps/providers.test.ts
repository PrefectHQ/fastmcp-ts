import { describe, it } from 'vitest'

describe('Apps — Built-in Providers', () => {
  describe('Approval', () => {
    it.todo('presents a confirm/deny UI card to the user')
    it.todo('the user\'s decision is injected back into the conversation via ui/message')
    it.todo('returns the decision to the requesting tool')
  })

  describe('Choice', () => {
    it.todo('presents a list of clickable options for the user to select from')
    it.todo('returns the selected option to the requesting tool')
  })

  describe('FileUpload', () => {
    it.todo('presents a drag-and-drop file picker UI')
    it.todo('stores uploaded files server-side, bypassing the LLM context window')
    it.todo('returns file content and metadata to the requesting tool')
  })

  describe('FormInput', () => {
    it.todo('generates a form UI from a Zod schema')
    it.todo('returns validated form data to the requesting tool on submission')
    it.todo('displays field-level validation errors when the user submits invalid data')
  })
})
