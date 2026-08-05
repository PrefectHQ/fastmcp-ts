/**
 * Fixture: a FastMCP server generated from the petstore OpenAPI spec.
 * Used by the CLI smoke test (`fastmcp inspect --file ...`) to prove the
 * OpenAPI integration works through the bundled CLI's in-process spawn.
 */
import { readFileSync } from 'node:fs'
import { createOpenAPIServer } from '../../src/server/index.js'

const spec = readFileSync(new URL('./openapi/petstore-3.1.json', import.meta.url), 'utf8')

const server = createOpenAPIServer({ spec, name: 'petstore-openapi-fixture' })

server.run()
