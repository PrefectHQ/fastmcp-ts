import { describe, it } from 'vitest'

describe('Server — Middleware', () => {
  describe('pipeline', () => {
    it.todo('middleware runs before the handler and can inspect the request')
    it.todo('middleware runs after the handler and can inspect the response')
    it.todo('middleware can short-circuit the pipeline and return early')
    it.todo('multiple middleware layers execute in registration order on the way in and reverse on the way out')
  })

  describe('built-in middleware', () => {
    it.todo('request logging middleware emits structured logs for every operation')
    it.todo('caching middleware returns a stored response for repeated identical requests')
    it.todo('rate limiting middleware rejects requests that exceed the configured limit')
    it.todo('size-limiting middleware rejects responses that exceed the configured byte threshold')
    it.todo('error normalization middleware maps thrown errors to correct MCP error codes and shapes')
    it.todo('cancellation middleware intercepts notifications/cancelled and aborts the in-flight handler')
  })

  describe('per-method hooks', () => {
    it.todo('on_call_tool hook fires only for tools/call requests')
    it.todo('on_list_tools hook fires only for tools/list requests')
    it.todo('on_read_resource hook fires only for resources/read requests')
    it.todo('on_list_resources hook fires only for resources/list requests')
    it.todo('on_get_prompt hook fires only for prompts/get requests')
    it.todo('on_list_prompts hook fires only for prompts/list requests')
  })

  describe('custom middleware', () => {
    it.todo('a custom middleware function receives the request, a next() callback, and the context')
    it.todo('values set via ctx.setState() by middleware are available in downstream tool handlers')
  })
})
