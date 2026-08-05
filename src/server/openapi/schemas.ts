/**
 * Schema manipulation for OpenAPI operations.
 *
 * Port of Python FastMCP's `fastmcp.utilities.openapi.schemas`. The quirks are
 * deliberate parity: the flat input schema keeps an empty `required: []`, the
 * request-body content schema is mutated IN PLACE (the request director later
 * reads the mutated version to decide body construction), and discriminator
 * subtypes are flattened into optional fields rather than emitted as a
 * top-level union. The snapshots in `tests/fixtures/openapi/` pin all of it.
 */

import type { HTTPRoute, JsonSchema, ParameterMapping, ResponseInfo } from './types'
import { deepEqual, isPlainObject, truthy } from './internal'
import { convertOpenAPISchemaToJsonSchema } from './jsonSchema'

export const EXTERNAL_REF_MESSAGE = 'External or non-local reference not supported'

export function isExternalRefError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(EXTERNAL_REF_MESSAGE)
}

/**
 * Replace OpenAPI `#/components/schemas/X` refs with JSON Schema `#/$defs/X`
 * recursively. Throws on external (non-`#/`) references.
 */
export function replaceRefWithDefs(info: JsonSchema, description?: string): JsonSchema {
  const schema: JsonSchema = { ...info }
  const refPath = schema.$ref
  if (truthy(refPath)) {
    if (typeof refPath === 'string') {
      if (refPath.startsWith('#/components/schemas/')) {
        schema.$ref = `#/$defs/${refPath.split('/').pop()}`
      } else if (!refPath.startsWith('#/')) {
        throw new Error(
          `${EXTERNAL_REF_MESSAGE}: ${refPath}. FastMCP only supports local schema ` +
            `references starting with '#/'. Please include all schema definitions ` +
            `within the OpenAPI document.`,
        )
      }
    }
  } else if (truthy(schema.properties)) {
    const properties = schema.properties as Record<string, unknown>
    if ('$ref' in properties) {
      // A property literally named "$ref": the Python implementation treats the
      // whole properties map as one schema in this case. Same here, for parity.
      schema.properties = replaceRefWithDefs(properties as JsonSchema)
    } else {
      schema.properties = Object.fromEntries(
        Object.entries(properties).map(([name, prop]) => [
          name,
          isPlainObject(prop) ? replaceRefWithDefs(prop) : prop,
        ]),
      )
    }
  } else if (truthy(schema.items)) {
    if (isPlainObject(schema.items)) {
      schema.items = replaceRefWithDefs(schema.items)
    }
  }
  for (const section of ['anyOf', 'allOf', 'oneOf'] as const) {
    const list = schema[section]
    if (Array.isArray(list)) {
      schema[section] = list.map((item) => (isPlainObject(item) ? replaceRefWithDefs(item) : item))
    }
  }
  const additionalProperties = schema.additionalProperties
  if (truthy(additionalProperties) && isPlainObject(additionalProperties)) {
    schema.additionalProperties = replaceRefWithDefs(additionalProperties)
  }
  const propertyNames = schema.propertyNames
  if (truthy(propertyNames) && isPlainObject(propertyNames)) {
    schema.propertyNames = replaceRefWithDefs(propertyNames)
  }
  const patternProperties = schema.patternProperties
  if (truthy(patternProperties) && isPlainObject(patternProperties)) {
    schema.patternProperties = Object.fromEntries(
      Object.entries(patternProperties).map(([pattern, sub]) => [
        pattern,
        isPlainObject(sub) ? replaceRefWithDefs(sub) : sub,
      ]),
    )
  }
  if (info.description === undefined && truthy(description) && !truthy(schema.description)) {
    schema.description = description
  }
  return schema
}

/** Expand local schema references while collecting `allOf` members. */
function allofMembers(
  schema: JsonSchema,
  schemaDefs: Record<string, JsonSchema>,
  resolving: ReadonlySet<string> = new Set(),
): JsonSchema[] {
  const ref = schema.$ref
  if (typeof ref === 'string') {
    for (const prefix of ['#/$defs/', '#/components/schemas/']) {
      if (ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length)
        const referenced = schemaDefs[name]
        if (isPlainObject(referenced) && !resolving.has(name)) {
          const siblings = Object.fromEntries(
            Object.entries(schema).filter(([key]) => key !== '$ref'),
          )
          const members = allofMembers(referenced, schemaDefs, new Set([...resolving, name]))
          return truthy(siblings) ? [...members, siblings] : members
        }
        break
      }
    }
  }

  const allOf = schema.allOf
  if (Array.isArray(allOf)) {
    const members: JsonSchema[] = []
    for (const member of allOf) {
      if (isPlainObject(member)) {
        members.push(...allofMembers(member, schemaDefs, resolving))
      }
    }
    const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'allOf'))
    return truthy(siblings) ? [...members, siblings] : members
  }

  return [schema]
}

/**
 * Resolve a `discriminator.mapping` value to a local schema name. Mapping
 * values hold "schema names or references": a bare `"Cat"` means the `Cat`
 * component just as `"#/components/schemas/Cat"` does.
 */
export function discriminatorTargetName(target: string): string | null {
  for (const prefix of ['#/$defs/', '#/components/schemas/']) {
    if (target.startsWith(prefix)) {
      return target.slice(prefix.length) || null
    }
  }
  if (target.startsWith('#') || target.includes('/')) return null
  return target || null
}

/**
 * Flatten the subtypes named by an OpenAPI `discriminator.mapping` into the
 * parent's properties. Variant fields merge in as optional; properties that
 * disagree between variants become an anyOf; the tag property's description
 * spells out the accepted values. Returns replacement properties, or null when
 * there is no usable mapping.
 */
function flattenDiscriminatorSubtypes(
  schema: JsonSchema,
  schemaDefs: Record<string, JsonSchema>,
): Record<string, unknown> | null {
  const discriminator = schema.discriminator
  if (!isPlainObject(discriminator)) return null

  const propertyName = discriminator.propertyName
  const mapping = discriminator.mapping
  if (typeof propertyName !== 'string' || !isPlainObject(mapping)) return null

  const ownProps = isPlainObject(schema.properties) ? schema.properties : {}
  const alternatives = new Map<string, unknown[]>()
  const values: string[] = []
  const variants: string[] = []

  for (const [value, target] of Object.entries(mapping)) {
    if (typeof target !== 'string') continue

    const name = discriminatorTargetName(target)
    const subtype = name !== null ? schemaDefs[name] : undefined
    if (!isPlainObject(subtype)) continue

    // Fields the parent already declares are shared, not variant-specific.
    const variantFields: string[] = []
    for (const member of allofMembers(subtype, schemaDefs)) {
      const memberProps = isPlainObject(member.properties) ? member.properties : {}
      for (const [propName, propSchema] of Object.entries(memberProps)) {
        if (propName in ownProps) continue
        if (!variantFields.includes(propName)) variantFields.push(propName)
        const seen = alternatives.get(propName) ?? []
        if (!seen.some((existing) => deepEqual(existing, propSchema))) seen.push(propSchema)
        alternatives.set(propName, seen)
      }
    }

    values.push(`'${value}'`)
    if (variantFields.length > 0) {
      variants.push(`'${value}' uses ${variantFields.join(', ')}`)
    }
  }

  if (values.length === 0) return null

  const subtypeProps = Object.fromEntries(
    [...alternatives.entries()].map(([propName, schemas]) => [
      propName,
      schemas.length === 1 ? schemas[0] : { anyOf: schemas },
    ]),
  )
  const properties: Record<string, unknown> = { ...ownProps, ...subtypeProps }

  let note = `Selects the variant. Accepted values: ${values.join(', ')}.`
  if (variants.length > 0) {
    note += ` ${variants.join('; ')}. Send only the fields belonging to the selected variant.`
  }

  // The discriminator names a property of the payload, so give it a schema even
  // when the parent left it undeclared.
  const existing = properties[propertyName]
  const tagSchema: JsonSchema = isPlainObject(existing) ? existing : { type: 'string' }
  const existingDesc = tagSchema.description
  properties[propertyName] = {
    ...tagSchema,
    description: truthy(existingDesc) ? `${existingDesc as string} ${note}` : note,
  }

  return properties
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Combine parameter and request-body schemas into the flat input schema
 * advertised on the MCP tool, and build the parameter map that routes flat
 * arguments back to their OpenAPI locations at request time.
 *
 * Mirrors the Python parser's pre-calculation path (`convert_refs=False`):
 * refs are already converted, `$defs` is attached unpruned, and the body
 * content schema is mutated in place.
 */
export function combineSchemasAndMapParams(
  route: HTTPRoute,
): [JsonSchema, Record<string, ParameterMapping>] {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  const parameterMap: Record<string, ParameterMapping> = {}

  const paramNamesByLocation = {
    path: new Set<string>(),
    query: new Set<string>(),
    header: new Set<string>(),
    cookie: new Set<string>(),
  }
  let bodySchema: JsonSchema = {}
  let bodyProps: Record<string, unknown> = {}

  for (const param of route.parameters) {
    paramNamesByLocation[param.location].add(param.name)
  }

  const requestBody = route.requestBody
  if (requestBody && truthy(requestBody.contentSchema)) {
    const contentType = Object.keys(requestBody.contentSchema)[0]
    bodySchema = requestBody.contentSchema[contentType]

    if (truthy(requestBody.description) && !truthy(bodySchema.description)) {
      bodySchema.description = requestBody.description
    }

    if ('allOf' in bodySchema && Array.isArray(bodySchema.allOf)) {
      const mergedProps: Record<string, unknown> = {}
      const mergedRequired: string[] = []

      for (const subSchema of allofMembers(bodySchema, route.requestSchemas)) {
        if ('properties' in subSchema && isPlainObject(subSchema.properties)) {
          Object.assign(mergedProps, subSchema.properties)
        }
        if ('required' in subSchema && Array.isArray(subSchema.required)) {
          mergedRequired.push(...(subSchema.required as string[]))
        }
      }

      bodySchema.properties = mergedProps
      if (mergedRequired.length > 0) {
        bodySchema.required = [...new Set(mergedRequired)]
      }
      delete bodySchema.allOf
    }

    // Merge discriminated subtype fields in as optional. The discriminator
    // itself is dropped: its mapping points at definitions that would leave
    // dangling refs once pruned from $defs.
    const flattenedProps = flattenDiscriminatorSubtypes(bodySchema, route.requestSchemas)
    if (flattenedProps !== null) {
      bodySchema.properties = flattenedProps
      delete bodySchema.discriminator
    }

    bodyProps = isPlainObject(bodySchema.properties) ? bodySchema.properties : {}
  }

  // Collisions: a name used in more than one non-body location, or shared
  // between body and a parameter location.
  const allNonBodyParams = new Set<string>()
  for (const names of Object.values(paramNamesByLocation)) {
    for (const name of names) allNonBodyParams.add(name)
  }
  const bodyParamNames = new Set(Object.keys(bodyProps))
  const paramCounts = new Map<string, number>()
  for (const param of route.parameters) {
    paramCounts.set(param.name, (paramCounts.get(param.name) ?? 0) + 1)
  }
  const collidingParams = new Set<string>()
  for (const name of allNonBodyParams) {
    if (bodyParamNames.has(name)) collidingParams.add(name)
  }
  for (const [name, count] of paramCounts) {
    if (count > 1) collidingParams.add(name)
  }

  for (const param of route.parameters) {
    const paramSchema: JsonSchema = { ...param.schema }
    if (truthy(param.description) && !truthy(paramSchema.description)) {
      paramSchema.description = param.description
    }

    if (collidingParams.has(param.name)) {
      const suffixedName = `${param.name}__${param.location}`
      if (param.required) required.push(suffixedName)
      parameterMap[suffixedName] = { location: param.location, openapiName: param.name }

      const originalDesc = truthy(paramSchema.description) ? (paramSchema.description as string) : ''
      const locationDesc = `(${capitalize(param.location)} parameter)`
      paramSchema.description = originalDesc ? `${originalDesc} ${locationDesc}` : locationDesc

      properties[suffixedName] = paramSchema
    } else {
      if (param.required) required.push(param.name)
      parameterMap[param.name] = { location: param.location, openapiName: param.name }
      properties[param.name] = paramSchema
    }
  }

  // Request body properties are added without suffixes.
  if (requestBody && truthy(requestBody.contentSchema)) {
    if ('$ref' in bodySchema && !truthy(bodyProps)) {
      // The entire body is a reference: keep it as a single `body` property.
      properties.body = bodySchema
      if (requestBody.required) required.push('body')
      parameterMap.body = { location: 'body', openapiName: 'body' }
    } else if (truthy(bodyProps)) {
      for (const [propName, propSchema] of Object.entries(bodyProps)) {
        properties[propName] = propSchema
        parameterMap[propName] = { location: 'body', openapiName: propName }
      }
      if (requestBody.required) {
        required.push(...((bodySchema.required as string[] | undefined) ?? []))
      }
    } else {
      // Direct array/primitive body: name the parameter from the schema title.
      let paramName = String(
        typeof bodySchema.title === 'string' ? bodySchema.title : 'body',
      ).toLowerCase()
      paramName = paramName.replace(/[^a-zA-Z0-9_]/g, '_')
      if (!paramName || /^\d/.test(paramName)) paramName = 'body_data'

      properties[paramName] = bodySchema
      if (requestBody.required) required.push(paramName)
      parameterMap[paramName] = { location: 'body', openapiName: paramName }
    }
  }

  let result: JsonSchema = { type: 'object', properties, required }
  if (truthy(route.requestSchemas)) {
    result.$defs = route.requestSchemas
  }

  if (route.openapiVersion?.startsWith('3')) {
    result = convertOpenAPISchemaToJsonSchema(result, route.openapiVersion)
  }

  return [result, parameterMap]
}

const SUCCESS_CODE_PRIORITY = ['200', '201', '202', '204'] as const

const JSON_COMPATIBLE_TYPES = [
  'application/json',
  'application/vnd.api+json',
  'application/hal+json',
  'application/ld+json',
  'text/json',
] as const

/**
 * Extract the MCP tool output schema from OpenAPI responses: first success
 * response, JSON-compatible content type preferred, non-object schemas
 * wrapped in `{result}` with the `x-fastmcp-wrap-result` marker.
 */
export function extractOutputSchemaFromResponses(
  responses: Record<string, ResponseInfo>,
  schemaDefinitions?: Record<string, JsonSchema>,
  openapiVersion?: string,
): JsonSchema | null {
  if (!truthy(responses)) return null

  let responseInfo: ResponseInfo | undefined
  for (const statusCode of SUCCESS_CODE_PRIORITY) {
    if (statusCode in responses) {
      responseInfo = responses[statusCode]
      break
    }
  }
  if (responseInfo === undefined) {
    for (const [statusCode, respInfo] of Object.entries(responses)) {
      if (statusCode.startsWith('2')) {
        responseInfo = respInfo
        break
      }
    }
  }
  if (responseInfo === undefined || !truthy(responseInfo.contentSchema)) return null

  let schema: JsonSchema | undefined
  for (const contentType of JSON_COMPATIBLE_TYPES) {
    if (contentType in responseInfo.contentSchema) {
      schema = responseInfo.contentSchema[contentType]
      break
    }
  }
  if (schema === undefined) {
    const firstContentType = Object.keys(responseInfo.contentSchema)[0]
    schema = responseInfo.contentSchema[firstContentType]
  }

  if (!truthy(schema) || !isPlainObject(schema)) return null

  let outputSchema = replaceRefWithDefs(schema)

  // A top-level $ref is inlined from the definitions before further handling.
  if (typeof outputSchema.$ref === 'string' && schemaDefinitions && truthy(schemaDefinitions)) {
    const refPath = outputSchema.$ref
    if (refPath.startsWith('#/$defs/')) {
      const schemaName = refPath.split('/').pop() as string
      if (schemaName in schemaDefinitions) {
        outputSchema = replaceRefWithDefs(schemaDefinitions[schemaName])
      }
    }
  }

  if (openapiVersion?.startsWith('3')) {
    outputSchema = convertOpenAPISchemaToJsonSchema(outputSchema, openapiVersion)
  }

  // MCP requires output schemas to be objects; wrap anything else.
  if (outputSchema.type !== 'object') {
    outputSchema = {
      type: 'object',
      properties: { result: outputSchema },
      required: ['result'],
      'x-fastmcp-wrap-result': true,
    }
  }

  if (schemaDefinitions && truthy(schemaDefinitions)) {
    const processedDefs: Record<string, JsonSchema> = { ...schemaDefinitions }
    for (const [name, defSchema] of Object.entries(processedDefs)) {
      if (isPlainObject(defSchema)) {
        processedDefs[name] = replaceRefWithDefs(defSchema)
      }
    }
    if (openapiVersion?.startsWith('3')) {
      for (const name of Object.keys(processedDefs)) {
        processedDefs[name] = convertOpenAPISchemaToJsonSchema(processedDefs[name], openapiVersion)
      }
    }
    outputSchema.$defs = processedDefs
  }

  return outputSchema
}
