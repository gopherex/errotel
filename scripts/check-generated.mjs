import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'

const paths = [
  'packages/sdk/src/protocol.ts',
  'packages/api/src/gen',
  'openapi/openapi.json',
  'services/errotel/internal/oas',
  'services/errotel/internal/envelope/app-debug-v1.schema.json',
  'services/errotel/internal/discovery/agent.md',
  'services/errotel/internal/discovery/openapi.json',
]
function fingerprint(path) {
  if (statSync(path).isDirectory())
    return readdirSync(path)
      .sort()
      .map((name) => fingerprint(`${path}/${name}`))
  return [path, createHash('sha256').update(readFileSync(path)).digest('hex')]
}
const before = JSON.stringify(paths.map(fingerprint))
execFileSync('make', ['generate'], { stdio: 'inherit' })
if (before !== JSON.stringify(paths.map(fingerprint)))
  throw new Error('Generated contracts drifted. Run make generate and commit the result.')
