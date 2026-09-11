import { mkdir, readFile, writeFile } from 'node:fs/promises'

// Build-only projection for ogen 1.20.3. Public OpenAPI and the wire schema
// remain OpenAPI 3.1 / JSON Schema 2020-12.
function project(value) {
  if (Array.isArray(value)) return value.map(project)
  if (!value || typeof value !== 'object') return value
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, project(item)])
  )
  if ('const' in result) {
    result.enum = [result.const]
    result.type ??= typeof result.const === 'number' ? 'integer' : typeof result.const
    delete result.const
  }
  if (result.type === 'null') {
    delete result.type
    result.nullable = true
  }
  return result
}

const spec = project(JSON.parse(await readFile('openapi/openapi.json', 'utf8')))
spec.openapi = '3.0.3'
// Arbitrary user JSON must stay lossless. Ogen's raw Any type preserves null,
// numbers and unknown keys; the ORIGINAL envelope schema validates it on read.
// Ogen cannot generate the optional recursive exception tree inside a required
// exception. Preserve nested nodes as raw JSON in Go only; the original runtime
// schema validates every node. Public OpenAPI and TS retain the recursive types.
spec.components.schemas.Wire_exceptionInfo = { type: 'object', additionalProperties: {} }
spec.components.schemas.Wire_json = {}
await mkdir('openapi/.build', { recursive: true })
await writeFile('openapi/.build/openapi-go.json', `${JSON.stringify(spec, null, 2)}\n`)
