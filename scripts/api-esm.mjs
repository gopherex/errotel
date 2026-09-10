// openapi-ts 0.64 emits extensionless imports. Node ESM consumers need .js;
// keep the correction in generation so browser and published builds agree.
import { readdir, readFile, writeFile } from 'node:fs/promises'
const directory = new URL('../packages/api/src/gen/', import.meta.url)
for (const name of await readdir(directory)) {
  if (!name.endsWith('.ts')) continue
  const file = new URL(name, directory)
  const source = await readFile(file, 'utf8')
  await writeFile(
    file,
    source.replace(
      /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
      (_, before, path, after) => `${before}${path.endsWith('.js') ? path : `${path}.js`}${after}`
    )
  )
}
