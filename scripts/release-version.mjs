import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const manifests = [
  'packages/sdk/package.json',
  'packages/api/package.json',
  'app/package.json',
]
export function versionOf(input) {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input ?? ''))
    throw new Error('Expected a stable version X.Y.Z or vX.Y.Z')
  return input.replace(/^v/, '')
}
export function checkVersion(input, root = '.') {
  const version = versionOf(input)
  for (const file of manifests) {
    const pkg = JSON.parse(readFileSync(resolve(root, file)))
    if (pkg.version !== version)
      throw new Error(`${file}: expected ${version}, found ${pkg.version}`)
    for (const name of ['@gopherex/errotel-sdk', '@gopherex/errotel-api'])
      if (pkg.dependencies?.[name] && pkg.dependencies[name] !== version)
        throw new Error(`${file}: ${name} dependency does not match ${version}`)
  }
  return version
}
export function setVersion(input, root = '.') {
  const version = versionOf(input)
  for (const file of manifests) {
    const path = resolve(root, file)
    const pkg = JSON.parse(readFileSync(path))
    pkg.version = version
    for (const name of ['@gopherex/errotel-sdk', '@gopherex/errotel-api'])
      if (pkg.dependencies?.[name]) pkg.dependencies[name] = version
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input] = process.argv.slice(2)
  if (mode === 'set') setVersion(input)
  else if (mode === 'check') console.log(checkVersion(input))
  else throw new Error('Usage: release-version.mjs check|set X.Y.Z')
}
