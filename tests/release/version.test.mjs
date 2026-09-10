import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { checkVersion, manifests, setVersion, versionOf } from '../../scripts/release-version.mjs'

test('release versions stay synchronized across packages and workspace consumers', () => {
  const root = mkdtempSync(join(tmpdir(), 'errotel-version-'))
  try {
    for (const file of manifests) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(
        join(root, file),
        JSON.stringify({ version: '0.1.0', dependencies: { '@gopherex/errotel-sdk': '0.1.0' } })
      )
    }
    setVersion('v0.2.3', root)
    assert.equal(checkVersion('0.2.3', root), '0.2.3')
    assert.throws(() => checkVersion('0.2.4', root), /expected/)
    for (const value of ['v01.2.3', '1.0.0-rc.1', '1.2', '1.2.3; touch bad', '', undefined])
      assert.throws(() => versionOf(value))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release dry run leaves git untouched; dirty trees and existing tags fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'errotel-release-test-'))
  const work = join(root, 'work')
  const remote = join(root, 'remote.git')
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: work,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  try {
    mkdirSync(work)
    git('init', '-b', 'master')
    git('config', 'user.name', 'Release Test')
    git('config', 'user.email', 'release@example.invalid')
    for (const file of [
      ...manifests,
      'scripts/release.mjs',
      'scripts/release-version.mjs',
      'scripts/release-menu.mjs',
    ]) {
      mkdirSync(dirname(join(work, file)), { recursive: true })
      cpSync(resolve(file), join(work, file))
    }
    git('add', '.')
    git('commit', '-m', 'fixture')
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
    git('remote', 'add', 'origin', remote)
    git('push', 'origin', 'master')
    const invoke = (...args) =>
      spawnSync(process.execPath, ['scripts/release.mjs', ...args], { cwd: work, encoding: 'utf8' })
    const before = git('rev-parse', 'HEAD')
    const plan = invoke('--dry-run', '0.2.0')
    assert.equal(plan.status, 0, plan.stderr)
    assert.match(plan.stdout, /Dry run/)
    assert.equal(git('status', '--porcelain'), '')
    assert.equal(git('rev-parse', 'HEAD'), before)
    assert.equal(git('tag', '-l'), '')
    writeFileSync(join(work, 'user-change'), 'preserve me')
    const dirty = invoke('0.2.0')
    assert.notEqual(dirty.status, 0)
    assert.match(dirty.stderr, /not clean/)
    assert.equal(readFileSync(join(work, 'user-change'), 'utf8'), 'preserve me')
    rmSync(join(work, 'user-change'))
    git('tag', 'v0.2.0')
    git('push', 'origin', 'v0.2.0')
    assert.match(invoke('--dry-run', '0.2.0').stderr, /already exists/)
    assert.match(invoke('--dry-run', '0.1.0').stderr, /must be newer/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
