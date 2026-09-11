import { readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../packages/sdk/', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
writeFileSync(
  new URL('src/version.ts', root),
  `// Generated from package.json by scripts/sdk-version.mjs.\nexport const SDK_VERSION = '${version}'\n`
)
