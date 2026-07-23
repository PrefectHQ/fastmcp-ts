import { describe, it, expect, vi } from 'vitest'
import { ProtocolError } from '@modelcontextprotocol/client'
import { FastMCP } from 'fastmcp-ts/server'
import { connectEra, describeEachEra } from '../helpers/eras'

// ---------------------------------------------------------------------------
// completion/complete is in BOTH era wire registries (legacy 2025-11-25 and the
// modern 2026-07-28 dispatch registry — unlike resources/subscribe, which is
// legacy-only). So the `completions` capability and the handler are declared
// unconditionally, and every case runs across all four transport/era combos with
// no era fork.
// ---------------------------------------------------------------------------

describeEachEra('Server — Completion', (combo) => {
  describe('capability', () => {
    it('the server advertises the completions capability', async () => {
      const mcp = new FastMCP({ name: 'test' })
      const { client, close } = await connectEra(mcp, combo)
      try {
        expect(client.getServerCapabilities()?.completions).toBeDefined()
      } finally {
        await close()
      }
    })
  })

  describe('prompt-argument completion', () => {
    it('returns the values produced by an argument completer', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt(
        {
          name: 'greet',
          description: 'greet',
          arguments: [{ name: 'style', complete: () => ['formal', 'casual', 'friendly'] }],
        },
        () => 'hi',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.complete({
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'style', value: 'f' },
        })
        expect(result.completion.values).toEqual(['formal', 'casual', 'friendly'])
      } finally {
        await close()
      }
    })

    it('forwards the typed value and resolved-argument context to the completer', async () => {
      const spy = vi.fn(() => ['x'])
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt(
        {
          name: 'translate',
          description: 'translate',
          arguments: [{ name: 'target', complete: spy }],
        },
        () => 'hi',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        await client.complete({
          ref: { type: 'ref/prompt', name: 'translate' },
          argument: { name: 'target', value: 'sp' },
          context: { arguments: { source: 'en' } },
        })
        expect(spy).toHaveBeenCalledWith('sp', { arguments: { source: 'en' } })
      } finally {
        await close()
      }
    })

    it('returns an empty list for an argument that has no completer', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt(
        {
          name: 'greet',
          description: 'greet',
          arguments: [{ name: 'style' }],
        },
        () => 'hi',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.complete({
          ref: { type: 'ref/prompt', name: 'greet' },
          argument: { name: 'style', value: 'x' },
        })
        expect(result.completion.values).toEqual([])
      } finally {
        await close()
      }
    })

    it('rejects an unknown prompt ref with an invalid-params error', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt({ name: 'greet', description: 'greet' }, () => 'hi')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const err = await client
          .complete({ ref: { type: 'ref/prompt', name: 'nope' }, argument: { name: 'x', value: '' } })
          .catch((e: unknown) => e)
        expect(err).toBeInstanceOf(ProtocolError)
        expect((err as ProtocolError).code).toBe(-32602)
      } finally {
        await close()
      }
    })

    it('does not advertise the completer in prompts/list arguments', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt(
        {
          name: 'greet',
          description: 'greet',
          arguments: [{ name: 'style', description: 'tone', required: true, complete: () => ['a'] }],
        },
        () => 'hi',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const { prompts } = await client.listPrompts()
        const arg = (prompts[0].arguments as Array<Record<string, unknown>>)[0]
        expect(arg).toEqual({ name: 'style', description: 'tone', required: true })
        expect(arg.complete).toBeUndefined()
      } finally {
        await close()
      }
    })
  })

  describe('resource-template variable completion', () => {
    it('returns the values produced by a template-variable completer', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource(
        {
          uri: 'file:///{name}',
          name: 'files',
          complete: { name: () => ['readme.md', 'changelog.md'] },
        },
        (params) => `content of ${params?.name}`,
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.complete({
          ref: { type: 'ref/resource', uri: 'file:///{name}' },
          argument: { name: 'name', value: 'r' },
        })
        expect(result.completion.values).toEqual(['readme.md', 'changelog.md'])
      } finally {
        await close()
      }
    })

    it('returns an empty list for a template variable with no completer', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'file:///{name}', name: 'files' }, () => 'x')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.complete({
          ref: { type: 'ref/resource', uri: 'file:///{name}' },
          argument: { name: 'name', value: 'r' },
        })
        expect(result.completion.values).toEqual([])
      } finally {
        await close()
      }
    })

    it('rejects an unknown resource-template ref with an invalid-params error', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.resource({ uri: 'file:///{name}', name: 'files' }, () => 'x')
      const { client, close } = await connectEra(mcp, combo)
      try {
        const err = await client
          .complete({ ref: { type: 'ref/resource', uri: 'nope:///{x}' }, argument: { name: 'x', value: '' } })
          .catch((e: unknown) => e)
        expect(err).toBeInstanceOf(ProtocolError)
        expect((err as ProtocolError).code).toBe(-32602)
      } finally {
        await close()
      }
    })
  })

  describe('static-resource ref (no oracle)', () => {
    // A ref/resource whose URI names a registered STATIC resource (not a template)
    // is a valid completion ref with nothing to complete — the SDK's high-level
    // server answers it with an empty list. But that answer must only be given for
    // a resource the caller could actually READ: a disabled or auth-gated static
    // resource (hidden from resources/list, -32602 or auth-rejected on read) must be
    // INDISTINGUISHABLE from an unknown URI, exactly as task-11 closed for subscribe.
    // Otherwise completion is an existence oracle over the hidden resource set.
    it('a disabled or auth-gated static resource is indistinguishable from an unknown URI (matches read)', async () => {
      const mcp = new FastMCP({ name: 'test' })
      // Enabled, open static resource — the control: completion answers empty.
      mcp.resource({ uri: 'data://open', name: 'open' }, () => 'open')
      // Disabled: hidden from list, -32602 on read.
      mcp.resource({ uri: 'data://disabled', name: 'disabled', disabled: true }, () => 'x')
      // Auth-gated: hidden from list; read rejects via the auth guard (no token).
      mcp.resource({ uri: 'data://secret', name: 'secret', auth: () => {} }, () => 'x')

      const { client, close } = await connectEra(mcp, combo)
      try {
        // Control: an enabled, open static resource still completes to an empty list.
        // (No behavior change for the readable case.)
        const openResult = await client.complete({
          ref: { type: 'ref/resource', uri: 'data://open' },
          argument: { name: 'x', value: '' },
        })
        expect(openResult.completion.values).toEqual([])

        // Structural fingerprint with the client-supplied URI factored out, so two
        // errors are "identical" iff they differ only by the URI the client sent.
        const shape = (e: unknown, uri: string) => ({
          ctor: (e as object).constructor.name,
          code: (e as ProtocolError).code,
          msg: (e as ProtocolError).message.split(uri).join('<uri>'),
        })

        // --- Disabled static resource --------------------------------------------
        const disReadErr = await client.readResource({ uri: 'data://disabled' }).catch((e: unknown) => e)
        const disCompErr = await client
          .complete({ ref: { type: 'ref/resource', uri: 'data://disabled' }, argument: { name: 'x', value: '' } })
          .catch((e: unknown) => e)
        const unkCompErr = await client
          .complete({ ref: { type: 'ref/resource', uri: 'data://nope' }, argument: { name: 'x', value: '' } })
          .catch((e: unknown) => e)
        expect(disCompErr).toBeInstanceOf(ProtocolError)
        // Identity with read (the oracle-relevant dimension): same error code.
        expect((disCompErr as ProtocolError).code).toBe((disReadErr as ProtocolError).code)
        // Indistinguishable from an unknown URI: same class, code, and message shape.
        expect(shape(disCompErr, 'data://disabled')).toEqual(shape(unkCompErr, 'data://nope'))

        // --- Auth-gated static resource, no token --------------------------------
        const secReadErr = await client.readResource({ uri: 'data://secret' }).catch((e: unknown) => e)
        const secCompErr = await client
          .complete({ ref: { type: 'ref/resource', uri: 'data://secret' }, argument: { name: 'x', value: '' } })
          .catch((e: unknown) => e)
        expect(secCompErr).toBeInstanceOf(ProtocolError)
        // Rejected identically to read: completion runs the SAME auth guard, so the
        // code AND message match read exactly (not the completer's empty list).
        expect((secCompErr as ProtocolError).code).toBe((secReadErr as ProtocolError).code)
        expect((secCompErr as ProtocolError).message).toBe((secReadErr as ProtocolError).message)
      } finally {
        await close()
      }
    })
  })

  describe('CompleteResult shape', () => {
    it('a bare array return fills total and hasMore (SDK parity)', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt(
        { name: 'p', description: 'p', arguments: [{ name: 'q', complete: () => ['a', 'b'] }] },
        () => 'hi',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.complete({
          ref: { type: 'ref/prompt', name: 'p' },
          argument: { name: 'q', value: '' },
        })
        expect(result.completion.values).toEqual(['a', 'b'])
        expect(result.completion.total).toBe(2)
        expect(result.completion.hasMore).toBe(false)
      } finally {
        await close()
      }
    })

    it('an object return round-trips explicit total and hasMore', async () => {
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt(
        {
          name: 'p',
          description: 'p',
          arguments: [{ name: 'q', complete: () => ({ values: ['a', 'b'], total: 10, hasMore: true }) }],
        },
        () => 'hi',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.complete({
          ref: { type: 'ref/prompt', name: 'p' },
          argument: { name: 'q', value: '' },
        })
        expect(result.completion.values).toEqual(['a', 'b'])
        expect(result.completion.total).toBe(10)
        expect(result.completion.hasMore).toBe(true)
      } finally {
        await close()
      }
    })

    it('caps values at the 100-item wire maximum', async () => {
      const many = Array.from({ length: 150 }, (_, i) => `v${i}`)
      const mcp = new FastMCP({ name: 'test' })
      mcp.prompt(
        { name: 'p', description: 'p', arguments: [{ name: 'q', complete: () => many }] },
        () => 'hi',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const result = await client.complete({
          ref: { type: 'ref/prompt', name: 'p' },
          argument: { name: 'q', value: '' },
        })
        expect(result.completion.values).toHaveLength(100)
        expect(result.completion.total).toBe(150)
        expect(result.completion.hasMore).toBe(true)
      } finally {
        await close()
      }
    })
  })

  describe('auth', () => {
    it('enforces the prompt auth check before completing (no oracle)', async () => {
      const mcp = new FastMCP({ name: 'test' })
      // auth: () => {} marks the prompt auth-gated; with no token on the wire the
      // check rejects before the completer runs — the same guard prompts/get applies.
      mcp.prompt(
        {
          name: 'secret',
          description: 'secret',
          auth: () => {},
          arguments: [{ name: 'q', complete: () => ['leak'] }],
        },
        () => 'hi',
      )
      const { client, close } = await connectEra(mcp, combo)
      try {
        const getErr = await client
          .getPrompt({ name: 'secret', arguments: {} })
          .catch((e: unknown) => e)
        const completeErr = await client
          .complete({ ref: { type: 'ref/prompt', name: 'secret' }, argument: { name: 'q', value: '' } })
          .catch((e: unknown) => e)
        expect(completeErr).toBeInstanceOf(ProtocolError)
        expect(getErr).toBeInstanceOf(ProtocolError)
        expect((completeErr as ProtocolError).code).toBe((getErr as ProtocolError).code)
      } finally {
        await close()
      }
    })
  })
})
