import { describe, it } from 'vitest'

describe('Client — Handlers', () => {
  describe('logHandler', () => {
    it.todo('is called with a LogMessage when the server emits a log notification')
    it.todo('LogMessage includes level, optional logger name, and data payload')
    it.todo('handles all eight severity levels: debug, info, notice, warning, error, critical, alert, emergency')
    it.todo('default handler forwards messages to Node console at the appropriate level')
    it.todo('notice maps to console.info and alert/emergency map to console.error by default')
  })

  describe('progressHandler', () => {
    it.todo('is called with progress and total when a tool reports progress')
    it.todo('is called with an optional message string alongside progress values')
    it.todo('receives multiple calls for a single tool invocation as progress advances')
  })

  describe('samplingHandler', () => {
    it.todo('is called when the server requests an LLM completion')
    it.todo('receives messages, params (system prompt, temperature, maxTokens, tools), and context')
    it.todo('the return value is forwarded back to the server as the completion result')
    it.todo('built-in Anthropic adapter forwards the request to the Anthropic SDK')
    it.todo('built-in OpenAI adapter forwards the request to the OpenAI SDK')
    it.todo('a custom handler function can be provided in place of a built-in adapter')
  })

  describe('elicitationHandler', () => {
    it.todo('is called when the server requests structured user input')
    it.todo('receives message, responseSchema (JSON Schema), params, and context')
    it.todo('returning { action: "accept", content } sends the data back to the server')
    it.todo('returning { action: "decline" } notifies the server the user opted out')
    it.todo('returning { action: "cancel" } aborts the in-progress operation')
  })

  describe('messageHandler', () => {
    it.todo('a function-based handler receives all server notifications')
    it.todo('class-based MessageHandler.onToolListChanged() fires when the tool list changes')
    it.todo('class-based MessageHandler.onResourceListChanged() fires when the resource list changes')
    it.todo('class-based MessageHandler.onPromptListChanged() fires when the prompt list changes')
  })
})
