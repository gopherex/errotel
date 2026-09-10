import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkVersion } from './release-version.mjs'

const version = checkVersion(process.env.VERSION)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const buildTime = new Date().toISOString()
const buildPackage = 'github.com/gopherex/errotel/services/errotel/internal/build'
const ldflags = `-s -w -X ${buildPackage}.Version=${version} -X ${buildPackage}.Commit=${commit} -X ${buildPackage}.BuildTime=${buildTime}`
const output = resolve('dist/release')
mkdirSync(output, { recursive: true })
const targets = (
  process.env.RELEASE_TARGETS ?? 'linux/amd64 linux/arm64 darwin/amd64 darwin/arm64'
).split(' ')
for (const target of targets) {
  if (!/^(linux|darwin)\/(amd64|arm64)$/.test(target))
    throw new Error(`Unsupported archive target: ${target}`)
  const [goos, goarch] = target.split('/')
  const stage = mkdtempSync(join(tmpdir(), 'errotel-release-'))
  try {
    execFileSync(
      'go',
      ['build', '-trimpath', `-ldflags=${ldflags}`, '-o', join(stage, 'errotel'), './cmd/errotel'],
      {
        cwd: 'services/errotel',
        stdio: 'inherit',
        env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
      }
    )
    cpSync('app/dist', join(stage, 'ui'), { recursive: true })
    for (const file of ['README.md', 'LICENSE']) cpSync(file, join(stage, file))
    cpSync('app/public/third-party-notices.txt', join(stage, 'THIRD_PARTY_NOTICES.md'))
    cpSync('openapi/openapi.json', join(stage, 'openapi.json'))
    cpSync('docs/agent.md', join(stage, 'agent.md'))
    mkdirSync(join(stage, 'docs'))
    for (const guide of ['sdk.md', 'ui.md', 'http-api.md', 'development.md', 'query-language.md']) {
      cpSync(join('docs', guide), join(stage, 'docs', guide))
    }
    writeFileSync(
      join(stage, 'config.yaml'),
      readFileSync('config.example.yaml', 'utf8').replace('ui_dir: ../../app/dist', 'ui_dir: ./ui')
    )
    writeFileSync(
      join(stage, 'version.json'),
      `${JSON.stringify({ version, commit, buildTime, target }, null, 2)}\n`
    )
    execFileSync('tar', [
      '-czf',
      join(output, `errotel_${version}_${goos}_${goarch}.tar.gz`),
      '-C',
      stage,
      '.',
    ])
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
const assets = readdirSync(output)
  .filter((name) => name.includes(version) && /\.(tgz|tar.gz)$/.test(name))
  .sort()
writeFileSync(
  join(output, 'SHA256SUMS'),
  assets
    .map(
      (name) =>
        `${createHash('sha256')
          .update(readFileSync(join(output, name)))
          .digest('hex')}  ${name}\n`
    )
    .join('')
)
console.log(`Release assets: ${output}`)
