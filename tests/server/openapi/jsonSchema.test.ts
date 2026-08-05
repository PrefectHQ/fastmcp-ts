import { describe, expect, it } from 'vitest'
import { convertOpenAPISchemaToJsonSchema } from '../../../src/server/openapi/jsonSchema'

describe('convertOpenAPISchemaToJsonSchema', () => {
  describe('nullable (OpenAPI 3.0)', () => {
    it('converts nullable string type to a type array', () => {
      expect(
        convertOpenAPISchemaToJsonSchema({ type: 'string', nullable: true }, '3.0.3'),
      ).toEqual({ type: ['string', 'null'] })
    })

    it('appends null to an existing type array', () => {
      expect(
        convertOpenAPISchemaToJsonSchema({ type: ['string', 'integer'], nullable: true }, '3.0.3'),
      ).toEqual({ type: ['string', 'integer', 'null'] })
    })

    it('converts nullable oneOf to anyOf with a null branch', () => {
      expect(
        convertOpenAPISchemaToJsonSchema(
          { nullable: true, oneOf: [{ type: 'string' }, { type: 'integer' }] },
          '3.0.3',
        ),
      ).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] })
    })

    it('adds null to anyOf only when not already present', () => {
      expect(
        convertOpenAPISchemaToJsonSchema(
          { nullable: true, anyOf: [{ type: 'string' }, { type: 'null' }] },
          '3.0.3',
        ),
      ).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    })

    it('wraps nullable allOf in anyOf', () => {
      expect(
        convertOpenAPISchemaToJsonSchema({ nullable: true, allOf: [{ type: 'string' }] }, '3.0.3'),
      ).toEqual({ anyOf: [{ allOf: [{ type: 'string' }] }, { type: 'null' }] })
    })

    it('appends null to enum values', () => {
      expect(
        convertOpenAPISchemaToJsonSchema(
          { type: 'string', enum: ['a', 'b'], nullable: true },
          '3.0.3',
        ),
      ).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] })
    })

    it('strips nullable: false without converting', () => {
      expect(
        convertOpenAPISchemaToJsonSchema({ type: 'string', nullable: false }, '3.0.3'),
      ).toEqual({ type: 'string' })
    })

    it('strips nullable without conversion on 3.1', () => {
      expect(
        convertOpenAPISchemaToJsonSchema({ type: 'string', nullable: true }, '3.1.0'),
      ).toEqual({ type: 'string' })
    })
  })

  it('converts oneOf to anyOf on every 3.x version', () => {
    for (const version of ['3.0.3', '3.1.0']) {
      expect(
        convertOpenAPISchemaToJsonSchema({ oneOf: [{ type: 'string' }] }, version),
      ).toEqual({ anyOf: [{ type: 'string' }] })
    }
  })

  it('strips OpenAPI-specific fields', () => {
    expect(
      convertOpenAPISchemaToJsonSchema(
        {
          type: 'object',
          readOnly: true,
          writeOnly: false,
          xml: { name: 'x' },
          externalDocs: { url: 'https://example.com' },
          deprecated: true,
          discriminator: { propertyName: 'kind' },
        },
        '3.1.0',
      ),
    ).toEqual({ type: 'object' })
  })

  it('requires the discriminator tag in each variant before dropping the keyword', () => {
    expect(
      convertOpenAPISchemaToJsonSchema(
        {
          discriminator: { propertyName: 'kind' },
          oneOf: [
            { type: 'object', properties: { kind: { type: 'string' } } },
            { type: 'object', required: ['other'] },
            { type: 'object', required: ['kind'] },
          ],
        },
        '3.1.0',
      ),
    ).toEqual({
      anyOf: [
        { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
        { type: 'object', required: ['other', 'kind'] },
        { type: 'object', required: ['kind'] },
      ],
    })
  })

  it('recurses into properties, items, $defs, and composition lists', () => {
    expect(
      convertOpenAPISchemaToJsonSchema(
        {
          type: 'object',
          properties: {
            a: { type: 'string', nullable: true },
            b: { type: 'array', items: { type: 'integer', nullable: true } },
          },
          $defs: { D: { oneOf: [{ type: 'string' }] } },
          allOf: [{ readOnly: true, type: 'object' }],
          additionalProperties: { type: 'string', nullable: true },
          not: { type: 'integer', nullable: true },
        },
        '3.0.3',
      ),
    ).toEqual({
      type: 'object',
      properties: {
        a: { type: ['string', 'null'] },
        b: { type: 'array', items: { type: ['integer', 'null'] } },
      },
      $defs: { D: { anyOf: [{ type: 'string' }] } },
      allOf: [{ type: 'object' }],
      additionalProperties: { type: ['string', 'null'] },
      not: { type: ['integer', 'null'] },
    })
  })

  it('returns schemas without OpenAPI constructs unchanged', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(convertOpenAPISchemaToJsonSchema(schema, '3.1.0')).toEqual(schema)
  })
})
