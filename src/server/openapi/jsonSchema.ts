/**
 * OpenAPI 3.x schema → JSON Schema conversion.
 *
 * Port of Python FastMCP's `fastmcp.utilities.openapi.json_schema_converter`
 * (plus `require_discriminator_property` from `fastmcp.utilities.json_schema`).
 * The conversion order is part of the parity contract:
 *
 * 1. nullable → type arrays / anyOf-with-null (OpenAPI 3.0 only; 3.1 has no
 *    `nullable`, so the keyword is simply stripped there)
 * 2. oneOf → anyOf (all 3.x — overlapping unions must not hard-fail)
 * 3. the discriminator's tag property is forced into each variant's
 *    `required` BEFORE the keyword is removed
 * 4. OpenAPI-specific fields removed
 * 5. readOnly (input direction) / writeOnly (output direction) properties
 *    dropped when requested, with removed names pruned from `required`
 * 6. recurse into nested schemas
 */

import type { JsonSchema } from './types'
import { isPlainObject, truthy } from './internal'

const OPENAPI_SPECIFIC_FIELDS = [
  'nullable',
  'discriminator',
  'readOnly',
  'writeOnly',
  'xml',
  'externalDocs',
  'deprecated',
] as const

const RECURSIVE_MAP_FIELDS = ['properties', '$defs', '$definitions'] as const
const RECURSIVE_SINGLE_FIELDS = ['items', 'additionalProperties', 'not'] as const
const RECURSIVE_LIST_FIELDS = ['allOf', 'anyOf', 'oneOf'] as const

/** Direction-dependent conversion options (Python: remove_read_only / remove_write_only). */
export interface ConvertOptions {
  /** Drop properties marked `readOnly: true` (the spec reserves them for responses). */
  removeReadOnly?: boolean
  /** Drop properties marked `writeOnly: true` (the spec reserves them for requests). */
  removeWriteOnly?: boolean
  /**
   * Remove `format` keywords. Used for output schemas: MCP SDK validators
   * enforce format assertions on structured results, but response data comes
   * from the upstream API and routinely deviates (issue #84). JSON Schema
   * 2020-12 treats `format` as an annotation by default anyway.
   * Only schemas the converter recurses into are stripped; formats under
   * keywords the Python-parity walk does not visit (patternProperties,
   * prefixItems, if/then/else, dependentSchemas) survive.
   */
  stripFormats?: boolean
}

/** Convert an OpenAPI 3.x schema (and everything nested in it) to JSON Schema. */
export function convertOpenAPISchemaToJsonSchema(
  schema: JsonSchema,
  openapiVersion?: string,
  options: ConvertOptions = {},
): JsonSchema {
  if (!isPlainObject(schema)) return schema

  let result: JsonSchema = { ...schema }

  if (openapiVersion?.startsWith('3.0')) {
    result = convertNullableField(result)
  }

  if ('oneOf' in result) {
    result.anyOf = result.oneOf
    delete result.oneOf
  }

  result = requireDiscriminatorProperty(result)

  for (const field of OPENAPI_SPECIFIC_FIELDS) {
    delete result[field]
  }

  if (options.stripFormats === true) {
    delete result.format
  }

  if (options.removeReadOnly === true || options.removeWriteOnly === true) {
    result = filterPropertiesByAccess(result, options)
  }

  for (const field of RECURSIVE_MAP_FIELDS) {
    const map = result[field]
    if (isPlainObject(map)) {
      result[field] = Object.fromEntries(
        Object.entries(map).map(([name, sub]) => [
          name,
          isPlainObject(sub) ? convertOpenAPISchemaToJsonSchema(sub, openapiVersion, options) : sub,
        ]),
      )
    }
  }
  for (const field of RECURSIVE_SINGLE_FIELDS) {
    const sub = result[field]
    if (isPlainObject(sub)) {
      result[field] = convertOpenAPISchemaToJsonSchema(sub, openapiVersion, options)
    }
  }
  for (const field of RECURSIVE_LIST_FIELDS) {
    const list = result[field]
    if (Array.isArray(list)) {
      result[field] = list.map((item) =>
        isPlainObject(item) ? convertOpenAPISchemaToJsonSchema(item, openapiVersion, options) : item,
      )
    }
  }

  return result
}

/** Convert OpenAPI 3.0 `nullable: true` into JSON Schema null unions. */
function convertNullableField(schema: JsonSchema): JsonSchema {
  if (!('nullable' in schema)) return schema

  const result = { ...schema }
  const nullableValue = result.nullable
  delete result.nullable

  if (!nullableValue) return result

  const currentType = result.type
  if ('type' in result) {
    if (typeof currentType === 'string') {
      result.type = [currentType, 'null']
    } else if (Array.isArray(currentType) && !currentType.includes('null')) {
      result.type = [...currentType, 'null']
    }
  } else if ('oneOf' in result) {
    result.anyOf = [...(result.oneOf as unknown[]), { type: 'null' }]
    delete result.oneOf
  } else if ('anyOf' in result) {
    const anyOf = result.anyOf as unknown[]
    if (!anyOf.some((item) => isPlainObject(item) && item.type === 'null')) {
      result.anyOf = [...anyOf, { type: 'null' }]
    }
  } else if ('allOf' in result) {
    result.anyOf = [{ allOf: result.allOf }, { type: 'null' }]
    delete result.allOf
  }

  if (Array.isArray(result.enum) && !result.enum.includes(null)) {
    result.enum = [...result.enum, null]
  }

  return result
}

/** Return a copy of `schema` with `propertyName` added to `required`. */
function requireProperty(schema: JsonSchema, propertyName: string): JsonSchema {
  const required = schema.required
  if (required === undefined || required === null) {
    return { ...schema, required: [propertyName] }
  }
  if (Array.isArray(required) && !required.includes(propertyName)) {
    return { ...schema, required: [...required, propertyName] }
  }
  return schema
}

/**
 * Keep an OpenAPI discriminator's tag mandatory after the keyword is dropped:
 * adds `discriminator.propertyName` to each anyOf/oneOf variant's `required`.
 */
export function requireDiscriminatorProperty(schema: JsonSchema): JsonSchema {
  const discriminator = schema.discriminator
  if (!isPlainObject(discriminator)) return schema
  const propertyName = discriminator.propertyName
  if (typeof propertyName !== 'string') return schema

  const result = { ...schema }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = result[key]
    if (!Array.isArray(variants)) continue
    result[key] = variants.map((variant) =>
      isPlainObject(variant) ? requireProperty(variant, propertyName) : variant,
    )
  }
  return result
}

/**
 * Drop properties whose access mode excludes them from this direction. Only
 * names actually removed are pruned from `required`; a schema with nothing to
 * remove passes through untouched, so an empty `required: []` survives.
 * Mirrors Python's `_filter_properties_by_access` (as amended by the pending
 * Python-side change; see tests/fixtures/openapi/patch_parity_venv.py).
 */
function filterPropertiesByAccess(schema: JsonSchema, options: ConvertOptions): JsonSchema {
  const properties = schema.properties
  if (!isPlainObject(properties)) return schema

  const removed = new Set<string>()
  for (const [name, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop)) continue
    if (
      (options.removeReadOnly === true && truthy(prop.readOnly)) ||
      (options.removeWriteOnly === true && truthy(prop.writeOnly))
    ) {
      removed.add(name)
    }
  }
  if (removed.size === 0) return schema

  const result: JsonSchema = { ...schema }
  result.properties = Object.fromEntries(
    Object.entries(properties).filter(([name]) => !removed.has(name)),
  )
  if (Array.isArray(result.required)) {
    result.required = result.required.filter(
      (name) => typeof name !== 'string' || !removed.has(name),
    )
  }
  return result
}
