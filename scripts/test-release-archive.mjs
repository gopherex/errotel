import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkVersion } from './release-version.mjs'

const version = checkVersion(process.env.VERSION)
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Archive runtime smoke test requires Linux amd64')
const stage = mkdtempSync(join(tmpdir(), 'errotel-archive-smoke-'))
let server
try {
  execFileSync('tar', [
    '-xzf',
    resolve(`dist/release/errotel_${version}_linux_amd64.tar.gz`),
    '-C',
    stage,
  ])
  const metadata = JSON.parse(
    execFileSync(join(stage, 'errotel'), ['-version'], { encoding: 'utf8' })
  )
  assert.equal(metadata.version, version)
  assert.equal(metadata.commit, JSON.parse(readFileSync(join(stage, 'version.json'))).commit)
  assert.ok(Number.isFinite(Date.parse(metadata.buildTime)))
  const portProbe = createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise((done) => portProbe.close(done))
  const config = join(stage, 'config.yaml')
  writeFileSync(
    config,
    readFileSync(config, 'utf8')
      .replace('127.0.0.1:8080', `127.0.0.1:${port}`)
      .replace('probe_addr: 127.0.0.1:8081', 'probe_addr: ""')
  )
  server = spawn(join(stage, 'errotel'), ['-config', config], {
    cwd: stage,
    stdio: 'ignore',
    env: { ...process.env, APP_DEBUG_API_TOKEN: 'archive-smoke-only' },
  })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Packaged server exited before readiness')
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/healthz/liveness`)).ok
      if (ready) break
    } catch {
      /* process startup */
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  assert.ok(ready)
  const request = (path, headers) => fetch(`http://127.0.0.1:${port}${path}`, { headers })
  const ui = await request('/')
  assert.equal(ui.status, 200)
  const html = await ui.text()
  assert.match(html, /<title>Errotel/i)
  const script = html.match(/src="([^"]+\.js)"/)[1]
  assert.equal((await request(script)).status, 200)
  assert.equal((await request('/openapi.json')).status, 200)
  assert.equal((await request('/api/v1/capabilities')).status, 401)
  assert.equal(
    (await request('/api/v1/capabilities', { Authorization: 'Bearer archive-smoke-only' })).status,
    200
  )
  console.log('Extracted server/UI archive, assets, discovery and authentication: OK')
} finally {
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit')
    server.kill('SIGTERM')
    await stopped
  }
  rmSync(stage, { recursive: true, force: true })
}
