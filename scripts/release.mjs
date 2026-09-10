import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { checkVersion, manifests, setVersion, versionOf } from './release-version.mjs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
const dryRun = process.argv.includes('--dry-run')
const versionArg = process.argv.slice(2).find((arg) => arg !== '--dry-run')
process.chdir(git('rev-parse', '--show-toplevel'))
const branch = git('symbolic-ref', '--short', 'HEAD')
if (branch !== 'master') throw new Error('Release from master; merge the reviewed changes first')
if (!dryRun && git('status', '--porcelain'))
  throw new Error('Working tree is not clean. Commit your changes first.')
const remoteRefs = git('ls-remote', '--heads', '--tags', 'origin')
const remoteHead = remoteRefs
  .split('\n')
  .find((line) => line.endsWith(`refs/heads/${branch}`))
  ?.split(/\s/)[0]
if (!remoteHead) throw new Error('Remote master is missing')
if (!dryRun) {
  run('git', ['fetch', 'origin', branch])
  run('git', ['merge-base', '--is-ancestor', remoteHead, 'HEAD'])
}
const published = remoteRefs
  .split('\n')
  .flatMap((line) => {
    const match = line.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/)
    return match ? [versionOf(match[1])] : []
  })
  .sort((a, b) => {
    const aa = a.split('.').map(Number),
      bb = b.split('.').map(Number)
    return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2]
  })
const latest = published.at(-1)
let target = versionArg
const prompt = createInterface({ input: process.stdin, output: process.stdout })
try {
  if (!target) {
    if (!process.stdin.isTTY)
      throw new Error('Use make release VERSION=X.Y.Z (or release-plan) outside a terminal')
    const current = latest ?? JSON.parse(readFileSync(manifests[0])).version
    const [major, minor, patch] = current.split('.').map(Number)
    const choices = latest
      ? [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major + 1}.0.0`]
      : [current]
    console.log(`Latest published tag: ${latest ? `v${latest}` : 'none'}`)
    choices.forEach((value, i) => {
      console.log(`${i + 1}) v${value}`)
    })
    target = choices[Number(await prompt.question('Version (number; anything else cancels): ')) - 1]
    if (!target) process.exit(0)
  }
  target = versionOf(target)
  const tag = `v${target}`
  if (
    remoteRefs.includes(`refs/tags/${tag}\n`) ||
    remoteRefs.endsWith(`refs/tags/${tag}`) ||
    git('tag', '-l', tag)
  )
    throw new Error(`${tag} already exists; published tags are immutable`)
  if (latest) {
    const proposed = target.split('.').map(Number),
      previous = latest.split('.').map(Number)
    const order =
      proposed[0] - previous[0] || proposed[1] - previous[1] || proposed[2] - previous[2]
    if (order <= 0) throw new Error(`Version must be newer than v${latest}`)
  }
  console.log(
    `Release ${tag}: SDK + API packages, ghcr.io/gopherex/errotel, server/UI archives and checksums.`
  )
  console.log(
    'Update workspace versions, validate, create a release commit and annotated tag, atomically push master + tag. CI gates publication.'
  )
  if (dryRun) {
    console.log('Dry run: no files, commits, tags or remote refs changed.')
  } else {
    if ((await prompt.question("Type 'yes' to release: ")) !== 'yes') process.exit(0)
    setVersion(target)
    run('yarn', ['install', '--frozen-lockfile'])
    run('make', ['ci'])
    checkVersion(target)
    const allowed = new Set(manifests)
    const changed = git('diff', '--name-only').split('\n').filter(Boolean)
    if (
      changed.some((file) => !allowed.has(file)) ||
      git('ls-files', '--others', '--exclude-standard')
    )
      throw new Error(
        'Validation changed files outside the version manifests; review before retrying'
      )
    run('git', ['add', '--', ...manifests])
    if (git('diff', '--cached', '--name-only'))
      run('git', ['commit', '-m', `chore(release): bump version to ${tag}`])
    run('git', ['tag', '-a', tag, '-m', tag])
    run('git', ['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`])
    console.log(`Pushed ${tag}. Publication status: https://github.com/gopherex/errotel/actions`)
  }
} finally {
  prompt.close()
}
