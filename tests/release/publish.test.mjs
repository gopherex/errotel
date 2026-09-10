import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('release publish command sends original tarball and correct metadata using Yarn 1', {
  timeout: 20000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'errotel-publish-test-'))
  let received
  const registry = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = {
      auth: request.headers.authorization,
      method: request.method,
      body: JSON.parse(Buffer.concat(chunks)),
    }
    response.writeHead(201, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  }).listen(0, '127.0.0.1')
  await once(registry, 'listening')
  try {
    const url = `http://127.0.0.1:${registry.address().port}`
    const source = join(root, 'source')
    mkdirSync(source)
    mkdirSync(join(root, 'dist/release'), { recursive: true })
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: '@gopherex/errotel-sdk',
        version: '0.1.0',
        license: 'MIT',
        publishConfig: { registry: url },
      })
    )
    writeFileSync(join(source, 'README.md'), 'Synthetic publish test only')
    const archive = join(root, 'dist/release/errotel-sdk-0.1.0.tgz')
    execFileSync('yarn', ['pack', '--filename', archive], { cwd: source, stdio: 'pipe' })
    const config = join(root, 'npmrc')
    writeFileSync(
      config,
      `//127.0.0.1:${registry.address().port}/:_authToken=synthetic-publish-only\n`
    )
    // Execute the actual workflow command; only the registry address is local.
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const block = workflow
      .split('      - name: Publish tested tarball to GitHub Packages')[1]
      .split('\n  release:')[0]
      .split('        run: |\n')[1]
    assert.ok(block)
    const script = block.replace(/^ {10}/gm, '').replaceAll('https://npm.pkg.github.com', url)
    const child = spawn('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: root,
      env: { ...process.env, VERSION: '0.1.0', PACKAGE: 'sdk', NPM_CONFIG_USERCONFIG: config },
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
    assert.equal(received?.method, 'PUT')
    assert.equal(received.auth, 'Bearer synthetic-publish-only')
    assert.equal(received.body.name, '@gopherex/errotel-sdk')
    assert.equal(received.body.versions['0.1.0'].version, '0.1.0')
    assert.deepEqual(
      Buffer.from(Object.values(received.body._attachments)[0].data, 'base64'),
      readFileSync(archive)
    )
  } finally {
    registry.closeAllConnections()
    await new Promise((done) => registry.close(done))
    rmSync(root, { recursive: true, force: true })
  }
})
