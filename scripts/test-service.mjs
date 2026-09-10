// Real, local VictoriaLogs/Traces/Metrics round-trip for the read service's own telemetry.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const binary = resolve('bin/errotel')
const stage = mkdtempSync(join(tmpdir(), 'errotel-service-test-'))
const token = `service-test-${randomUUID()}`
const traceId = randomBytes(16).toString('hex')
const parentId = randomBytes(8).toString('hex')
let processOutput = ''
let child
let logsAvailable = true
let tracesAvailable = true
let holdRead = false
let releaseRead
const proxy = createServer(async (request, response) => {
  const isTrace = request.url.startsWith('/select/jaeger')
  if (!(isTrace ? tracesAvailable : logsAvailable)) {
    response.writeHead(503).end()
    return
  }
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (holdRead && !isTrace) {
      holdRead = false
      await new Promise((resolveRead) => {
        releaseRead = resolveRead
      })
    }
    const target = `http://127.0.0.1:${isTrace ? 20428 : 19428}${request.url}`
    const upstream = await fetch(target, {
      method: request.method,
      headers: { 'Content-Type': request.headers['content-type'] ?? 'application/json' },
      body: request.method === 'POST' ? Buffer.concat(chunks) : undefined,
    })
    response.writeHead(upstream.status)
    response.end(Buffer.from(await upstream.arrayBuffer()))
  } catch {
    response.writeHead(502).end()
  }
}).listen(0, '127.0.0.1')
await once(proxy, 'listening')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function eventually(check) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for local VM telemetry')
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const [code, signal] = await exited
  assert.equal(code, 0, `service exited with ${code}/${signal}`)
}
try {
  for (const port of [19428, 20428, 18428]) {
    await eventually(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok
      } catch {
        return false
      }
    })
  }
  const metadata = JSON.parse(execFileSync(binary, ['-version'], { encoding: 'utf8' }))
  assert.equal(metadata.service, 'errotel')
  assert.notEqual(metadata.commit, 'unknown')
  assert.ok(Number.isFinite(Date.parse(metadata.buildTime)))
  const upstream = `http://127.0.0.1:${proxy.address().port}`
  const config = join(stage, 'config.yaml')
  writeFileSync(
    config,
    `listen: 127.0.0.1:0
ui_dir: ${resolve('app/dist')}
logs:
  base_url: ${upstream}
traces:
  base_url: ${upstream}/select/jaeger
service:
  logger:
    level: debug
  http:
    probe_addr: localhost:0
    probe_timeout: 500ms
`
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('OTEL_') && !key.startsWith('ERROTEL_')
    )
  )
  child = spawn(binary, ['-config', config], {
    env: {
      ...env,
      APP_DEBUG_API_TOKEN: token,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:20428/insert/opentelemetry/v1/traces',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:19428/insert/opentelemetry/v1/logs',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:18428/opentelemetry/v1/metrics',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=service-synthetic',
      OTEL_METRIC_EXPORT_INTERVAL: '500',
      OTEL_TRACES_SAMPLER: 'always_on',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (data) => {
    processOutput += data
  })
  child.stderr.on('data', (data) => {
    processOutput += data
  })
  const lines = () =>
    processOutput.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  await eventually(() => lines().filter((line) => line.msg === 'listening').length === 2)
  const listeners = lines().filter((line) => line.msg === 'listening')
  const api = `http://${listeners[0].address}`
  const management = `http://${listeners[1].address}`
  const instance = listeners[0].instance_id
  const request = async (path, body, authorized = true) =>
    fetch(api + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        traceparent: `00-${traceId}-${parentId}-01`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  const readiness = () => fetch(`${management}/healthz/readiness`)
  assert.equal((await readiness()).status, 200)
  assert.equal((await fetch(`${api}/healthz/readiness`)).status, 404)
  assert.equal((await fetch(`${api}/metrics`)).status, 404)
  assert.equal((await fetch(`${management}/api/v1/capabilities`)).status, 404)
  const end = BigInt(Date.now()) * 1000000n
  const search = {
    range: { startUnixNano: String(end - 60000000000n), endUnixNano: String(end) },
    origin: 'sdk',
  }
  assert.equal((await request('/api/v1/occurrences/search', search)).status, 200)
  assert.equal(
    (await request('/api/v1/occurrences/search', search)).headers.get('x-errotel-cache'),
    'hit'
  )
  assert.equal((await request('/api/v1/occurrences/search', search, false)).status, 401)
  const scrape = await (await fetch(`${management}/metrics`)).text()
  assert.match(scrape, /errotel_cache_requests_total.*outcome="hit"/)
  assert.match(scrape, /http_server_request_duration_seconds_count/)
  logsAvailable = false
  assert.equal((await readiness()).status, 503)
  assert.equal((await fetch(`${management}/healthz/liveness`)).status, 200)
  logsAvailable = true
  assert.equal((await readiness()).status, 200)
  tracesAvailable = false
  const missingTrace = await (await request(`/api/v1/traces/${'a'.repeat(32)}`)).json()
  assert.equal(missingTrace.status, 'unavailable')
  assert.equal((await readiness()).status, 200)
  tracesAvailable = true
  holdRead = true
  const inFlight = request('/api/v1/occurrences/search', {
    ...search,
    range: { ...search.range, endUnixNano: String(end + 1n) },
  })
  await eventually(() => Boolean(releaseRead))
  const draining = stop()
  await eventually(async () => (await readiness()).status === 503)
  releaseRead()
  assert.equal((await inFlight).status, 200)
  await draining // Drains an active request, then exports queued service telemetry.
  assert.ok(!processOutput.includes(token))
  assert.ok(!processOutput.includes('startUnixNano'))
  let spans
  await eventually(async () => {
    const reply = await fetch(`http://127.0.0.1:20428/select/jaeger/api/traces/${traceId}`)
    if (!reply.ok) return false
    const body = await reply.json()
    spans = body.data?.[0]?.spans
    return spans?.some((span) => span.operationName === 'victorialogs.query')
  })
  assert.ok(
    spans.some((span) => span.references?.some((reference) => reference.spanID === parentId))
  )
  await eventually(async () => {
    const body = new URLSearchParams({
      query: `_time:5m AND "service.instance.id":="${instance}" AND trace_id:="${traceId}" | limit 1`,
    })
    const response = await fetch('http://127.0.0.1:19428/select/logsql/query', {
      method: 'POST',
      body,
    })
    assert.ok(response.ok, 'VictoriaLogs telemetry query must succeed')
    const rows = (await response.text())
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    return rows.some((row) => row.trace_id === traceId && row['service.instance.id'] === instance)
  })
  await eventually(async () => {
    const url = new URL('http://127.0.0.1:18428/api/v1/series')
    url.searchParams.set('match[]', '{__name__=~"http.*server.*request.*duration.*"}')
    const body = await (await fetch(url)).json()
    return body.data?.some(
      (series) =>
        series['service.instance.id'] === instance &&
        /http.*server.*request.*duration/.test(series.__name__)
    )
  })
  console.log(
    'Real service → VictoriaLogs / VictoriaTraces / VictoriaMetrics: OK; scrape, cache auth, dependency failure/recovery, SIGTERM and build metadata: OK'
  )
} finally {
  releaseRead?.()
  await stop()
  await new Promise((done) => proxy.close(done))
  rmSync(stage, { recursive: true, force: true })
}
