import { copyFile, mkdir } from 'node:fs/promises'
// docs are the source of truth; generated copies are checked by contract tests.
await mkdir('services/errotel/internal/envelope', { recursive: true })
await copyFile('docs/protocol.ts', 'packages/sdk/src/protocol.ts')
await copyFile(
  'docs/app-debug-v1.schema.json',
  'services/errotel/internal/envelope/app-debug-v1.schema.json'
)

await mkdir('services/errotel/internal/discovery', { recursive: true })
await copyFile('docs/agent.md', 'services/errotel/internal/discovery/agent.md')
