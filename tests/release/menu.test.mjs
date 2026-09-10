import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseMenu } from '../../scripts/release-menu.mjs'

async function choose(answers, latest) {
  const output = []
  const result = await releaseMenu(
    async () => answers.shift(),
    latest,
    'abc123',
    (line) => {
      output.push(line)
    }
  )
  return { result, output: output.join('\n') }
}

test('first release has the same action and major/minor/patch menus as iam', async () => {
  for (const [number, version] of [
    ['1', '1.0.0'],
    ['2', '0.1.0'],
    ['3', '0.0.1'],
  ]) {
    const { result, output } = await choose(['1', number])
    assert.deepEqual(result, { kind: 'bump', version })
    assert.match(output, /Latest release: v0\.0\.0 {4}HEAD: abc123/)
    assert.match(
      output,
      /1\) bump version\n {2}2\) recreate last tag \(v0\.0\.0\) on HEAD {3}\[force\]\n {2}3\) cancel/
    )
    assert.match(
      output,
      /1\) major {2}-> v1\.0\.0\n {2}2\) minor {2}-> v0\.1\.0\n {2}3\) patch {2}-> v0\.0\.1/
    )
  }
})

test('existing release supports numeric bump, recreation and cancellation', async () => {
  assert.deepEqual((await choose(['1', '2'], '0.4.9')).result, { kind: 'bump', version: '0.5.0' })
  assert.deepEqual((await choose(['2'], '0.4.9')).result, { kind: 'recreate', version: '0.4.9' })
  for (const answers of [['3'], ['garbage'], ['1', 'garbage']])
    assert.deepEqual((await choose(answers, '0.4.9')).result, { kind: 'cancel' })
  await assert.rejects(choose(['2']), /No release tag to recreate/)
})
