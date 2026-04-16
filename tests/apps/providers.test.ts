import { describe, it } from 'vitest'

describe('Apps — Built-in Providers', () => {
  describe('Approval', () => {
    it.todo('presents a confirm/deny UI to the user')
    it.todo('returns the user\'s decision to the requesting tool')
  })

  describe('Choice', () => {
    it.todo('presents a list of options for the user to select from')
    it.todo('returns the selected option to the requesting tool')
  })

  describe('FileUpload', () => {
    it.todo('presents a file picker UI')
    it.todo('returns the uploaded file content and metadata to the requesting tool')
  })

  describe('FormInput', () => {
    it.todo('generates a form UI from a Zod schema')
    it.todo('returns validated form data to the requesting tool on submission')
    it.todo('displays field-level validation errors when the user submits invalid data')
  })
})
