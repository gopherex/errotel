import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const output = resolve('dist/release')
mkdirSync(output, { recursive: true })
for (const name of ['sdk', 'api']) {
  const source = resolve(`packages/${name}`)
  const pkg = JSON.parse(readFileSync(join(source, 'package.json')))
  const stage = mkdtempSync(join(tmpdir(), 'errotel-pack-'))
  try {
    cpSync(join(source, 'dist'), join(stage, 'dist'), { recursive: true })
    cpSync(join(source, 'package.json'), join(stage, 'package.json'))
    cpSync('LICENSE', join(stage, 'LICENSE'))
    cpSync(join(source, 'README.md'), join(stage, 'README.md'))
    execFileSync(
      'yarn',
      ['pack', '--filename', join(output, `errotel-${name}-${pkg.version}.tgz`)],
      { cwd: stage, stdio: 'inherit' }
    )
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
