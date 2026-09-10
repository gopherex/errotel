import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect, test, type Page } from '@playwright/test'
import type { InvestigationResponse, TraceResponse } from '@gopherex/errotel-api'
import type {
  OccurrenceDetail,
  OccurrenceSummary,
  SearchResponse,
} from '../../packages/sdk/src/protocol'
import type { outboxFixture } from './outbox-fixture'
import type { runScenario } from '../../examples/browser/main'

declare global {
  interface Window {
    outboxFixture: ReturnType<typeof outboxFixture>

    notificationTest: {
      permission: string
      requested: number
      sent: { title: string; body?: string; click?: () => void }[]
    }
    runScenario: typeof runScenario
  }
}
const root = resolve(import.meta.dirname, '../..')
const token = 'browser-isolated-synthetic-token'
const url = 'http://127.0.0.1:18581'
let processHandle: ChildProcess | undefined
let directory: string

async function start(traces = 'http://127.0.0.1:20428/select/jaeger') {
  const config = join(directory, 'config.yaml')
  await writeFile(
    config,
    `service:\n  http:\n    probe_addr: ""\nlisten: 127.0.0.1:18581\nsource: browser-synthetic\nui_connect_origins: [http://127.0.0.1:14318]\nui_dir: ${join(root, 'app/dist')}\nlogs:\n  base_url: http://127.0.0.1:19428\ntraces:\n  base_url: ${traces}\ncache:\n  max_entry_bytes: 1024\n  search_ttl: 100ms\n`
  )
  processHandle = spawn(join(root, 'bin/errotel'), ['-config', config], {
    cwd: root,
    env: { ...process.env, APP_DEBUG_API_TOKEN: token },
    stdio: 'ignore',
  })
  await expect
    .poll(async () => {
      if (processHandle?.exitCode != null) throw new Error('Read server exited before readiness')
      return fetch(`${url}/healthz/readiness`)
        .then((r) => r.status)
        .catch(() => 0)
    })
    .toBe(200)
}
async function stop() {
  if (!processHandle || processHandle.exitCode != null) return
  const stopped = once(processHandle, 'exit')
  processHandle.kill('SIGTERM')
  await stopped
  processHandle = undefined
}
async function api(path: string, body?: unknown, auth = token) {
  return fetch(`${url}/api/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
async function detail(item: OccurrenceSummary): Promise<OccurrenceDetail> {
  let response: Response | undefined
  await expect
    .poll(
      async () => {
        response = await api(`occurrences/${item.ref}`)
        if (response.status !== 404 && response.status !== 200)
          throw new Error(await response.text())
        return response.status
      },
      { timeout: 10_000 }
    )
    .toBe(200)
  if (!response) throw new Error('No detail response')
  return response.json()
}

async function connectUI(page: Page, path: string) {
  await page.goto(`${url}/${path}`)
  await page.reload()
  await page.getByLabel(/^API token/).fill(token)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  execFileSync(
    'docker',
    ['compose', 'up', '-d', 'victorialogs', 'victoriatraces', 'victoriametrics', 'collector'],
    { cwd: root, stdio: 'pipe' }
  )
  execFileSync('make', ['build-server'], { cwd: root, stdio: 'pipe' })
  execFileSync('yarn', ['workspace', '@errotel/ui', 'build'], { cwd: root, stdio: 'pipe' })
  directory = await mkdtemp(join(tmpdir(), 'errotel-browser-'))
})
test.afterEach(stop)
test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('real browser protobuf → VictoriaLogs → generated read API → same URL after process restart', async ({
  page,
}) => {
  await start()
  await page.goto('http://127.0.0.1:14173')
  await page.waitForFunction(() => typeof window.runScenario === 'function')
  const captured = await page.evaluate(() => window.runScenario({ largeBytes: 2 ** 20 }))
  const stamp = BigInt(captured.envelope.timestampUnixNano)
  const search = {
    range: { startUnixNano: String(stamp - 1n), endUnixNano: String(stamp + 1n) },
    service: captured.service,
  }
  let result: SearchResponse | undefined
  await expect
    .poll(
      async () => {
        const response = await api('occurrences/search', search)
        expect(response.status).toBe(200)
        result = await response.json()
        return result?.items.length
      },
      { timeout: 20_000 }
    )
    .toBe(1)
  const item = result?.items[0]
  if (!item) throw new Error('Missing captured occurrence')
  expect(item.eventId).toBe(captured.eventId)
  expect(item.traceId).toBe(captured.traceId)
  expect(JSON.stringify(result)).not.toContain('payload')
  const before = await detail(item)
  expect(before.payload.status).toBe('available')
  if (before.payload.status !== 'available') throw new Error('Invalid round-trip payload')
  expect(before.payload.value).toEqual(captured.envelope)
  expect(before.exception.stacktrace).toBe(captured.envelope.exception.stacktrace)
  expect(before.warnings).toEqual([])
  expect((await api(`occurrences/${item.ref}`)).headers.get('x-errotel-cache')).toBe('miss')
  await expect
    .poll(async () => (await api(`traces/${captured.traceId}`).then((r) => r.json())).status, {
      timeout: 45_000,
    })
    .toBe('available')
  const trace = await api(`traces/${captured.traceId}`).then((r) => r.json())
  expect(trace.data.spans.some((span: { spanId: string }) => span.spanId === captured.spanId)).toBe(
    true
  )
  for (const selector of [
    { ref: item.ref },
    { eventId: item.eventId, range: search.range },
    { search },
  ]) {
    const response = await api('investigate', selector)
    expect(response.status).toBe(200)
    const bundle: InvestigationResponse = await response.json()
    expect(bundle.occurrence).toEqual(before)
    expect(bundle.trace.result.status).toBe('available')
    if (bundle.trace.result.status !== 'available') throw new Error('Missing investigation trace')
    expect(bundle.trace.result.data.spans.some((span) => span.spanId === captured.spanId)).toBe(
      true
    )
    expect(bundle.relatedLogs.result.status).toBe('available')
    expect(bundle.occurrenceMeta.servedFrom).toBe('upstream') // 1 MiB body exceeds cache budget
    expect(JSON.stringify(bundle)).not.toContain(token)
  }
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const uiPath = `#/occurrences/${item.ref}`
  await connectUI(page, uiPath)
  await expect(page.getByTestId('stacktrace')).toHaveText(
    captured.envelope.exception.stacktrace ?? ''
  )
  await expect(page.getByRole('heading', { name: 'State at capture' })).toBeVisible()
  await page.getByRole('button', { name: 'Inline state' }).click()
  await expect(page.getByText('"applyPatch"', { exact: true }).first()).toBeVisible()
  await expect(page.locator('img, script[src^="http://attacker"]')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Trace', exact: true }).click()
  await expect(page.getByLabel('Filter spans')).toBeVisible()
  await page.screenshot({ path: 'test-results/trace.png', fullPage: true })
  const exactURL = `${url}/api/v1/occurrences/${item.ref}`
  await stop()
  await start('http://127.0.0.1:1/select/jaeger')
  const after = await fetch(exactURL, { headers: { Authorization: `Bearer ${token}` } }).then((r) =>
    r.json()
  )
  expect(after).toEqual(before)
  const investigation: InvestigationResponse = await api('investigate', { ref: item.ref }).then(
    (r) => r.json()
  )
  expect(investigation.occurrence).toEqual(before)
  expect(investigation.trace.result.status).toBe('unavailable')
  expect(investigation.status).toBe('partial')

  expect((await api(`traces/${captured.traceId}`).then((r) => r.json())).status).toBe('unavailable')
  expect((await detail(item)).payload.status).toBe('available')
  await connectUI(page, uiPath)
  await expect(page.getByTestId('stacktrace')).toHaveText(
    captured.envelope.exception.stacktrace ?? ''
  )
  await page.getByRole('tab', { name: 'Trace', exact: true }).click()
  await expect(page.getByText('unavailable', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Error & context' }).click()
  await expect(page.getByTestId('stacktrace')).toBeVisible()
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))
  ).toEqual({ local: 0, session: 0 })
  expect(pageErrors).toEqual([])
})

test('synthetic duplicates, conflict, invalid envelope, vanilla log, pagination and authorization', async ({
  page,
}) => {
  await start()
  await page.goto('http://127.0.0.1:14173')
  await page.waitForFunction(() => typeof window.runScenario === 'function')
  const captured = await page.evaluate(() => window.runScenario({ seedCases: true }))
  const stamp = BigInt(captured.envelope.timestampUnixNano)
  const search = {
    range: {
      startUnixNano: String(stamp - 1_000_000_000n),
      endUnixNano: String(stamp + 60_000_000_000n),
    },
    service: captured.service,
    pageSize: 200,
  }
  let result: SearchResponse | undefined
  await expect
    .poll(
      async () => {
        result = await api('occurrences/search', search).then((r) => r.json())
        return result?.items.some((item) => item.origin === 'otel-log')
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  if (!result) throw new Error('Missing search')
  expect(result.items.filter((item) => item.eventId === captured.eventId)).toHaveLength(1)
  const original = result.items.find((item) => item.eventId === captured.eventId)
  if (!original) throw new Error('Missing original SDK error')
  for (const kind of ['same_span', 'same_trace', 'same_runtime', 'time_window']) {
    const response = await api(`occurrences/${original.ref}/related`, { kind, pageSize: 50 })
    expect(response.status).toBe(200)
    const related = await response.json()
    expect(related.status).toBe('available')
    expect(related.data.evidence.kind).toBe(kind)
    expect(related.data.items.length).toBeGreaterThan(0)
  }

  expect(result.items.every((item) => item.message !== 'ERROR severity without an exception')).toBe(
    true
  )
  expect(result.items.some((item) => item.origin === 'sdk' && !item.eventId)).toBe(true)
  const details = await Promise.all(result.items.map(detail))
  expect(details.some((item) => item.payload.status === 'unsupported_version')).toBe(true)
  expect(details.some((item) => item.payload.status === 'invalid')).toBe(true)
  expect(details.some((item) => item.warnings.includes('event_id_body_conflict'))).toBe(true)
  expect(details.some((item) => item.warnings.includes('index_payload_mismatch'))).toBe(true)
  expect(
    details.some(
      (item) =>
        item.payload.status === 'absent' && item.exception.stacktrace === 'original vanilla stack'
    )
  ).toBe(true)
  const histogram = await api('occurrences/histogram', search).then((r) => r.json())
  expect(histogram.total).toBe(result.items.length)
  expect(histogram.meta.queryStatus).toBe('complete')
  for (const origin of ['sdk', 'otel-log']) {
    const filter = { op: 'eq', field: 'origin', value: origin }
    const filtered = await api('occurrences/search', { ...search, filter }).then((r) => r.json())
    expect(filtered.items.length).toBe(result.items.filter((item) => item.origin === origin).length)
    expect(filtered.items.every((item: OccurrenceSummary) => item.origin === origin)).toBe(true)
    const buckets = await api('occurrences/histogram', { ...search, filter }).then((r) => r.json())
    expect(buckets.total).toBe(filtered.items.length)
  }
  await connectUI(page, `#/occurrences/${original.ref}`)
  await expect(page.getByTestId('stacktrace')).toBeVisible()
  for (const status of ['unsupported_version', 'invalid', 'absent'] as const) {
    const selected = details.find((item) => item.payload.status === status)
    if (!selected) throw new Error(`Missing seeded ${status} payload`)
    await page.goto(`${url}/#/occurrences/${selected.summary.ref}`)
    await expect(
      page.getByText(`Diagnostic context: ${status.replaceAll('_', ' ')}`, { exact: true })
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'State at capture' })).toHaveCount(0)
  }
  const conflicted = details.find((item) => item.warnings.includes('event_id_body_conflict'))
  if (!conflicted) throw new Error('Missing conflict')
  await page.goto(`${url}/#/occurrences/${conflicted.summary.ref}`)
  await expect(page.getByText('event id body conflict', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Related logs' })).toBeDisabled()
  const latestSearch = { range: search.range, service: search.service }
  const latest: InvestigationResponse = await api('investigate', { search: latestSearch }).then(
    (r) => r.json()
  )
  expect(latest.selection.hasMoreMatches).toBe(true)
  expect(latest.occurrence.summary.ref).toBe(result.items[0].ref)
  const conflictBundle: InvestigationResponse = await api('investigate', {
    ref: conflicted.summary.ref,
  }).then((r) => r.json())
  expect(conflictBundle.trace.result).toEqual({
    status: 'unavailable',
    reason: 'conflicting_identifiers',
  })
  expect(conflictBundle.relatedLogs.result.status).toBe('unavailable')
  const first: SearchResponse = await api('occurrences/search', { ...search, pageSize: 1 }).then(
    (r) => r.json()
  )
  expect(first.nextCursor).toBeTruthy()
  const seenIDs: string[] = []
  let cursor: string | undefined
  do {
    const batch: SearchResponse = await api('occurrences/search', {
      ...search,
      origin: 'sdk',
      pageSize: 1,
      cursor,
    }).then((r) => r.json())
    seenIDs.push(...batch.items.map((item) => String(item.eventId)))
    cursor = batch.nextCursor
    expect(seenIDs.length).toBeLessThanOrEqual(6)
  } while (cursor)
  expect(seenIDs).toHaveLength(6)
  expect(new Set(seenIDs).size).toBe(6)
  const escaped: SearchResponse = await api('occurrences/search', {
    ...search,
    messageContains: '" OR * | limit 200',
  }).then((r) => r.json())
  expect(escaped.items).toEqual([])

  expect(
    (await api('occurrences/search', { ...search, pageSize: 1, cursor: first.nextCursor })).status
  ).toBe(200)
  expect(
    (
      await api('occurrences/search', {
        ...search,
        pageSize: 1,
        service: 'different',
        cursor: first.nextCursor,
      })
    ).status
  ).toBe(400)
  expect((await api('occurrences/invalid')).status).toBe(400)
  const caps = await api('capabilities')
  expect(caps.status).toBe(200)
  for (let index = 0; index < 5; index++)
    expect((await api('capabilities', undefined, `wrong-${index}`)).status).toBe(401)
  expect((await api('capabilities', undefined, 'another')).status).toBe(429)
  expect((await api('capabilities')).status).toBe(200)
})

test('native browser handlers preserve no-stack exceptions, other listeners and disposal', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:14173')
  const result = await page.evaluate(async (modulePath) => {
    const { createClient } = await import(modulePath)
    const records: { body?: unknown }[] = []
    const loggerProvider = {
      getLogger: () => ({ emit: (record: { body?: unknown }) => records.push(record) }),
    }
    let otherCalls = 0
    const other = () => {
      otherCalls++
    }
    window.addEventListener('error', other)
    const first = createClient({ loggerProvider, captureUnhandled: true })
    const second = createClient({ loggerProvider, captureUnhandled: true })
    const error = new ErrorEvent('error', {
      message: 'no stack <script>unsafe</script>',
      cancelable: true,
    })
    window.dispatchEvent(error)
    const rejected = new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.resolve(),
      reason: { secret: 'must not serialize' },
      cancelable: true,
    })
    window.dispatchEvent(rejected)
    window.dispatchEvent(new Event('error'))
    const payloads = records.map((record) => JSON.parse(String(record.body)))
    first.dispose()
    second.dispose()
    window.dispatchEvent(new ErrorEvent('error', { message: 'after dispose' }))
    window.removeEventListener('error', other)
    return {
      payloads,
      count: records.length,
      otherCalls,
      prevented: error.defaultPrevented || rejected.defaultPrevented,
    }
  }, '/main.ts')
  expect(result.count).toBe(2)
  expect(result.otherCalls).toBe(3)
  expect(result.prevented).toBe(false)
  expect(result.payloads[0].exception.stacktrace).toBeUndefined()
  expect(result.payloads[0].exception.message).toContain('<script>')
  expect(JSON.stringify(result.payloads)).not.toContain('must not serialize')
})

test('query, filters and histogram share undo; occurrence docks without losing context', async ({
  page,
}) => {
  await start()
  await page.goto('http://127.0.0.1:14173')
  await page.waitForFunction(() => typeof window.runScenario === 'function')
  const captured = await page.evaluate(() => window.runScenario())
  await expect
    .poll(
      async () => {
        const now = BigInt(Date.now()) * 1_000_000n
        const result = await api('occurrences/search', {
          service: captured.service,
          range: { startUnixNano: String(now - 900_000_000_000n), endUnixNano: String(now) },
        }).then((r) => r.json())
        return result.items.length
      },
      { timeout: 20_000 }
    )
    .toBe(1)
  const query = `time:[now-15m TO now} AND service:${JSON.stringify(captured.service)}`
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/')) requests.push(request.url())
  })
  await connectUI(page, `#/?q=${encodeURIComponent(query)}`)
  const editor = page.getByRole('textbox', { name: 'Search query' })
  const row = page.getByRole('button', { name: /SyntheticError Synthetic patch failed/ })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.histogram-heading strong')).toHaveText('1')
  expect(
    requests.some(
      (request) =>
        /occurrences\/[^/]+$/.test(request) &&
        !request.endsWith('/search') &&
        !request.endsWith('/histogram')
    )
  ).toBe(false)
  expect(requests.some((request) => request.includes('/traces/'))).toBe(false)
  await page.getByRole('button', { name: 'Add filter', exact: true }).click()
  await page.getByLabel('Value', { exact: true }).fill('missing-service')
  await page.getByRole('button', { name: 'Include', exact: true }).click()
  await expect(editor).toContainText('missing-service')
  await expect(page.locator('.histogram-heading strong')).toHaveText('0')
  await page.getByRole('heading', { name: 'Errors', exact: true }).click()
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText(query)
  await expect(row).toBeVisible()
  await page.keyboard.press('Control+Shift+z')
  await expect(editor).toContainText('missing-service')
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText(query)
  await expect(page.locator('.histogram-heading strong')).toHaveText('1')
  const plot = page.getByTestId('histogram-plot').locator('.u-over')
  const box = await plot.boundingBox()
  if (!box) throw new Error('Histogram did not render')
  await page.mouse.move(box.x + box.width * 0.25, box.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.75, box.y + 30, { steps: 10 })
  await page.mouse.up()
  await expect(editor).not.toContainText('now-15m')
  await expect(page.locator('.histogram-heading strong')).toHaveText('0')
  const zoomed = await editor.innerText()
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText(query)
  await expect(row).toBeVisible()
  await page.keyboard.press('Control+Shift+z')
  await expect(editor).toHaveText(zoomed)
  await expect(page.locator('.histogram-heading strong')).toHaveText('0')
  await page.evaluate(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'я',
        code: 'KeyZ',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
  )
  await expect(editor).toHaveText(query)
  await expect(row).toBeVisible()
  const geometry = await page.locator('.investigation-layout').evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    width: window.innerWidth,
  }))
  expect(geometry.left).toBe(0)
  expect(geometry.right).toBe(geometry.width)
  await page.getByRole('button', { name: 'Filter Environment', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Field', exact: true })).toHaveValue(
    'environment'
  )
  await page.getByLabel('Value', { exact: true }).fill('local-test')
  await page.getByRole('button', { name: 'Include', exact: true }).click()
  await expect(editor).toContainText('environment:"local-test"')
  await page.getByRole('button', { name: 'Undo query' }).click()
  await expect(editor).toHaveText(query)
  // CodeMirror keeps the same history when text is edited directly.
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' AND type:"SyntheticError"')
  await expect(editor).toContainText('type:"SyntheticError"')
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText(query)
  await page.getByRole('heading', { name: 'Errors', exact: true }).click()
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByTestId('stacktrace')).toHaveText(
    captured.envelope.exception.stacktrace ?? ''
  )
  await expect(page.locator('.investigation-layout')).toHaveAttribute('data-position', 'bottom')
  await page.getByRole('button', { name: 'editor ok' }).click()
  await expect(page.getByText('"Привет 世界"', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/search-bottom.png', fullPage: true })
  await page.getByRole('button', { name: 'Dock right', exact: true }).click()
  await expect(page.locator('.investigation-layout')).toHaveAttribute('data-position', 'right')
  await expect(page.getByText('"Привет 世界"', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Fullscreen occurrence' }).click()
  await expect(page.locator('.occurrence-panel')).toHaveClass(/fullscreen/)
  await expect(page.getByText('"Привет 世界"', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Exit fullscreen' }).click()
  await page.screenshot({ path: 'test-results/search-right.png', fullPage: true })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' AND (')
  await expect(page.getByRole('alert')).toContainText('Previous results remain visible')
  await expect(row).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(editor).toHaveText(query)
  expect(errors).toEqual([])
})

test('UI response fixtures: partial, cached and failed reads remain distinguishable', async ({
  page,
}) => {
  await start()
  let state: 'partial' | 'cache' | 'failure' = 'partial'
  await page.route('**/api/v1/occurrences/*', async (route) => {
    if (state === 'failure') {
      await route.fulfill({
        status: 503,
        json: { code: 'upstream_unavailable', message: 'upstream unavailable' },
      })
      return
    }
    const range = route.request().postDataJSON().range
    const meta = {
      queryStatus: state === 'partial' ? 'partial' : 'complete',
      servedFrom: state === 'cache' ? 'cache' : 'upstream',
      fetchedAt: new Date().toISOString(),
      warnings: state === 'partial' ? ['upstream_partial'] : [],
      ...(state === 'cache' ? { cacheAgeMs: 100 } : {}),
    }
    await route.fulfill({
      json: route.request().url().endsWith('/histogram')
        ? { range, intervalMs: 900000, total: 0, buckets: [{ ...range, count: 0 }], meta }
        : { range, items: [], meta },
    })
  })
  await connectUI(page, '#/')
  await expect(page.getByText('No matching rows in the returned partial data.')).toBeVisible()
  await expect(page.locator('.histogram-heading strong')).toHaveText('≥ 0')
  await expect(page.getByText('upstream partial', { exact: true })).toHaveCount(2)
  state = 'cache'
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('.result-meta')).toContainText('complete · cache')
  state = 'failure'
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(2)
  await expect(page.getByRole('alert').first()).toContainText('upstream unavailable')
  await expect(page.locator('.histogram-heading strong')).toHaveCount(0)
  await expect(page.getByText('No errors match this query and time range.')).toHaveCount(0)
})

test('test-error modal exports SDK errors with real traces and keeps the occurrence span linked', async ({
  page,
}) => {
  await start()
  await connectUI(page, '#/')
  const service = `ui-modal-${crypto.randomUUID()}`
  const requests: { contentType: string | undefined; auth: string | undefined }[] = []
  const traceRequests: { contentType: string | undefined; auth: string | undefined }[] = []
  const traceReads: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(`${url}/api/v1/traces/`)) traceReads.push(request.url())
    if (request.url() === 'http://127.0.0.1:14318/v1/traces' && request.method() === 'POST')
      traceRequests.push({
        contentType: request.headers()['content-type'],
        auth: request.headers().authorization,
      })
    if (request.url() === 'http://127.0.0.1:14318/v1/logs' && request.method() === 'POST')
      requests.push({
        contentType: request.headers()['content-type'],
        auth: request.headers().authorization,
      })
  })
  await page.getByRole('button', { name: 'Test errors' }).click()
  const modal = page.getByRole('dialog', { name: 'Send test errors' })
  await modal.getByRole('textbox', { name: /^Service/ }).fill(service)
  await modal.getByLabel('Error message').fill('Modal test <img src=x onerror=alert(1)>')
  await modal
    .getByLabel('Inline state · JSON')
    .fill('{"null":null,"false":false,"zero":0,"empty":"","ключ.с.точками":"世界"}')
  for (let index = 1; index <= 2; index++) {
    await modal.getByRole('button', { name: 'Send error', exact: true }).click()
    await expect(modal.getByText(`Sent: ${index}`, { exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('Sent to OTLP')
    await expect(modal).toBeVisible()
  }
  expect(requests).toHaveLength(2)
  expect(traceRequests).toHaveLength(6)
  expect(
    [...requests, ...traceRequests].every(
      (request) => request.contentType === 'application/x-protobuf' && !request.auth
    )
  ).toBe(true)
  const now = BigInt(Date.now()) * 1_000_000n
  let result: SearchResponse | undefined
  await expect
    .poll(
      async () => {
        result = await api('occurrences/search', {
          service,
          range: {
            startUnixNano: String(now - 900_000_000_000n),
            endUnixNano: String(now + 1_000_000_000n),
          },
        }).then((response) => response.json())
        return result?.items.length
      },
      { timeout: 20_000 }
    )
    .toBe(2)
  if (!result) throw new Error('Missing modal errors')
  const captures = await Promise.all(result.items.map(detail))
  expect(new Set(result.items.map((item) => item.eventId)).size).toBe(2)
  expect(new Set(result.items.map((item) => item.traceId)).size).toBe(2)
  for (const capture of captures) {
    expect(capture.exception.stacktrace).toContain('Modal test <img')
    if (capture.payload.status !== 'available') throw new Error('Missing SDK envelope')
    expect(capture.payload.value.state.inline).toMatchObject({
      status: 'ok',
      value: { null: null, false: false, zero: 0, empty: '', 'ключ.с.точками': '世界' },
    })
    expect(capture.payload.value.state.sources[0].name).toBe('test-generator')
    const link = { traceId: capture.summary.traceId, spanId: capture.summary.spanId }
    expect(link.traceId).toMatch(/^[a-f0-9]{32}$/)
    expect(link.spanId).toMatch(/^[a-f0-9]{16}$/)
    expect(capture.payload.value.trace).toMatchObject(link)
    for (const item of capture.payload.value.history.items.slice(-2))
      expect(item.trace).toMatchObject(link)
    let trace: TraceResponse | undefined
    await expect
      .poll(
        async () => {
          trace = await api(`traces/${link.traceId}`).then((response) => response.json())
          return trace && 'data' in trace ? trace.data.spans.length : 0
        },
        { timeout: 45_000 }
      )
      .toBe(3)
    if (!trace || !('data' in trace)) throw new Error('Missing real modal trace')
    const root = trace.data.spans.find((span) => span.operation === 'test.send-error')
    const failed = trace.data.spans.find((span) => span.spanId === link.spanId)
    expect(root).toBeDefined()
    expect(failed?.operation).toBe('test.capture-error')
    expect(failed?.parentSpanId).toBe(root?.spanId)
    expect(trace.data.spans.filter((span) => span.parentSpanId === root?.spanId)).toHaveLength(2)
    expect(failed?.tags).toContainEqual(expect.objectContaining({ key: 'error', value: 'true' }))
    expect(JSON.stringify(failed?.logs)).toContain('Modal test <img')
  }
  // A successful log export must not conceal a failed trace export.
  await modal.getByLabel('OTLP traces endpoint').fill('http://127.0.0.1:1/v1/traces')
  await modal.getByRole('button', { name: 'Send error', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText(
    'error log was exported, but its trace export failed',
    { timeout: 15_000 }
  )
  await expect(modal.getByText('Sent: 2', { exact: true })).toBeVisible()
  await modal.getByLabel('OTLP traces endpoint').fill('http://127.0.0.1:14318/v1/traces')
  await modal.getByRole('button', { name: 'Send error', exact: true }).click()
  await expect(modal.getByText('Sent: 3', { exact: true })).toBeVisible({ timeout: 15_000 })
  await modal.getByLabel('OTLP logs endpoint').fill('http://127.0.0.1:1/v1/logs')
  await modal.getByRole('button', { name: 'Send error', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('OTLP export failed', { timeout: 15_000 })
  await expect(page.getByText('Error was not confirmed sent', { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(modal.getByText('Sent: 3', { exact: true })).toBeVisible()
  await expect(modal).toBeVisible()
  await page.screenshot({ path: 'test-results/test-error-modal.png', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(modal).not.toBeVisible()
  await page.evaluate((ref) => {
    location.hash = `#/occurrences/${ref}`
  }, result.items[0].ref)
  await expect(page.getByTestId('stacktrace')).toBeVisible()
  expect(traceReads).toHaveLength(0)
  await page.getByRole('tab', { name: 'Trace', exact: true }).click()
  await expect(page.getByLabel('Filter spans')).toBeVisible()
  await expect(page.locator('.span-detail h2')).toHaveText('test.capture-error')
  await expect(page.locator('.span-detail code').first()).toHaveText(result.items[0].spanId ?? '')
  expect(traceReads).toHaveLength(1)
  await page.screenshot({ path: 'test-results/test-error-trace.png', fullPage: true })
})

test('search automation fixtures: manual mode, polling, deduplicated browser alerts and slow reads', async ({
  page,
}) => {
  await start()
  await page.addInitScript(() => {
    const state = {
      permission: 'default',
      requested: 0,
      sent: [] as { title: string; body?: string; click?: () => void }[],
    }
    Object.defineProperty(window, 'notificationTest', { value: state })
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class {
        static get permission() {
          return state.permission
        }
        static async requestPermission() {
          state.requested++
          state.permission = 'granted'
          return 'granted'
        }
        onclick?: () => void
        constructor(title: string, options?: NotificationOptions) {
          state.sent.push({ title, body: options?.body, click: () => this.onclick?.() })
        }
        close() {}
      },
    })
  })
  const stamp = BigInt(Date.now()) * 1_000_000n
  const makeItem = (id: string, offset: bigint) => ({
    ref: `fixture-${id}`,
    eventId: id,
    origin: 'sdk',
    timestampUnixNano: String(stamp + offset),
    service: 'automation',
    exceptionType: 'TestError',
    message: `error-${id}`,
    contextStatus: 'not_loaded',
  })
  let rows = [makeItem('a', 0n)]
  let requests = 0
  let details = 0
  let failure = false
  let partial = false
  let slow: Promise<void> | undefined
  let release: (() => void) | undefined
  const ranges: string[] = []
  await page.route('**/api/v1/occurrences/*', async (route) => {
    const path = route.request().url()
    if (!path.endsWith('/search') && !path.endsWith('/histogram')) {
      details++
      await route.fulfill({
        json: {
          summary: rows[rows.length - 1],
          exception: {
            type: 'TestError',
            message: 'error-a',
            stacktrace: 'original fixture stack',
          },
          payload: { status: 'absent' },
          storedFields: {},
          warnings: [],
        },
      })
      return
    }
    const isSearch = path.endsWith('/search')
    const range = route.request().postDataJSON().range
    if (isSearch) {
      requests++
      ranges.push(range.endUnixNano)
      if (slow) await slow
    }
    if (failure) {
      await route.fulfill({ status: 503, json: { code: 'upstream_unavailable' } })
      return
    }
    const meta = {
      queryStatus: partial ? 'partial' : 'complete',
      servedFrom: 'upstream',
      fetchedAt: new Date().toISOString(),
      warnings: [],
    }
    await route.fulfill({
      json: isSearch
        ? { range, items: rows, meta }
        : {
            range,
            intervalMs: 900000,
            total: rows.length,
            buckets: [{ ...range, count: rows.length }],
            meta,
          },
    })
  })
  await connectUI(page, '#/')
  await expect(page.getByRole('button', { name: 'TestError error-a', exact: true })).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Search query' })
  const base = 'time:[now-15m TO now}'
  await page.getByLabel('Auto query', { exact: true }).uncheck()
  let before = requests
  await editor.fill(`${base} AND service:manual`)
  await page.waitForTimeout(650)
  expect(requests).toBe(before)
  await page.getByRole('button', { name: 'Run query', exact: true }).click()
  await expect.poll(() => requests).toBe(before + 1)
  await page.getByLabel('Auto query', { exact: true }).check()
  await editor.fill(`${base} AND service:auto`)
  await expect.poll(() => requests).toBeGreaterThan(before + 1)
  await expect(page.locator('.result-meta')).toContainText('complete')
  before = requests
  await editor.fill('service:(')
  await page.waitForTimeout(650)
  expect(requests).toBe(before)
  await editor.fill(base)
  await expect.poll(() => requests).toBe(before + 1)
  await expect(page.locator('.result-meta')).toContainText('complete')
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(0)
  await page.getByRole('button', { name: 'Browser alerts', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Alerts on', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(1)
  expect(await page.evaluate(() => window.notificationTest.sent.length)).toBe(0)
  await page.getByRole('combobox', { name: 'Auto refresh interval' }).click()
  await page.getByRole('option', { name: 'Custom interval' }).click()
  await page.getByRole('textbox', { name: 'Custom refresh seconds' }).fill('5')
  await page.getByRole('heading', { name: 'Errors', exact: true }).click()
  await page.getByRole('button', { name: 'TestError error-a', exact: true }).click()
  await expect(page.getByTestId('stacktrace')).toHaveText('original fixture stack')
  rows = [makeItem('b', 1n), ...rows]
  await expect(page.getByRole('button', { name: 'TestError error-b', exact: true })).toBeVisible({
    timeout: 10_000,
  })
  expect(details).toBe(1)
  expect(await page.evaluate(() => window.notificationTest.sent.map((item) => item.title))).toEqual(
    ['Errotel · 1 new error']
  )
  expect(BigInt(ranges.at(-1) ?? '0')).toBeGreaterThan(BigInt(ranges[0]))
  before = requests
  await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThan(before)
  expect(await page.evaluate(() => window.notificationTest.sent.length)).toBe(1)
  failure = true
  await expect(page.getByRole('alert').first()).toContainText('upstream unavailable', {
    timeout: 10_000,
  })
  expect(await page.evaluate(() => window.notificationTest.sent.length)).toBe(1)
  failure = false
  partial = true
  rows = [makeItem('c', 2n), ...rows]
  await expect(page.locator('.result-meta')).toContainText('partial', { timeout: 10_000 })
  expect(await page.evaluate(() => window.notificationTest.sent.length)).toBe(1)
  partial = false
  slow = new Promise((resolve) => {
    release = resolve
  })
  before = requests
  await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThan(before)
  const held = requests
  await page.waitForTimeout(5500)
  expect(requests).toBe(held)
  await expect(page.getByTestId('stacktrace')).toHaveText('original fixture stack')
  slow = undefined
  release?.()
  await expect(page.locator('.result-meta')).toContainText('complete')
  expect(await page.evaluate(() => window.notificationTest.sent.length)).toBe(2)
  await page.evaluate(() => window.notificationTest.sent.at(-1)?.click?.())
  await expect(page).toHaveURL(/ref=fixture-c/)
  await page.getByRole('combobox', { name: 'Auto refresh interval' }).click()
  await page.getByRole('option', { name: 'Off', exact: true }).click()
  before = requests
  await page.waitForTimeout(5500)
  expect(requests).toBe(before)
  await page.getByRole('button', { name: 'Alerts on', exact: true }).click()
  await page.evaluate(() => {
    window.notificationTest.permission = 'denied'
  })
  await page.getByRole('button', { name: 'Browser alerts', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Notifications are blocked' })
  ).toBeVisible()
  expect(await page.evaluate(() => window.notificationTest.requested)).toBe(1)
})

test('alert generator uses the real search, previews a count and exports without applying configuration', async ({
  page,
}) => {
  await start()
  await page.goto('http://127.0.0.1:14173')
  await page.waitForFunction(() => typeof window.runScenario === 'function')
  const captured = await page.evaluate(() => window.runScenario())
  const query = `service:"${captured.service}" AND time:[now-15m TO now}`
  await expect
    .poll(
      async () => {
        const end = BigInt(Date.now()) * 1_000_000n
        const response = await api('occurrences/search', {
          service: captured.service,
          range: {
            startUnixNano: String(end - 300_000_000_000n),
            endUnixNano: String(end),
          },
        })
        return (await response.json()).items?.length
      },
      { timeout: 20000 }
    )
    .toBe(1)
  await connectUI(page, `#/?q=${encodeURIComponent(query)}`)
  await expect(page.getByRole('button', { name: 'Configure alert', exact: true })).toBeVisible()
  const external: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(url)) external.push(request.url())
  })
  await page.getByRole('button', { name: 'Configure alert', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Configure external alert' })
  await expect(modal.getByRole('combobox', { name: 'Deployment' })).toHaveValue(
    'File · Docker / systemd / binary'
  )
  await modal.getByRole('button', { name: 'Preview current count' }).click()
  await expect(
    modal.getByRole('alert').filter({ hasText: '1 matching errors · condition met' })
  ).toBeVisible({ timeout: 15000 })
  const generated = page.waitForResponse((response) => response.url().endsWith('/alerts/prepare'))
  await modal.getByRole('button', { name: 'Prepare configuration' }).click()
  const response = await generated
  expect(response.status()).toBe(200)
  const bundle = await response.json()
  expect(bundle.expression).toContain(captured.service)
  expect(bundle.expression).toContain('_time:300s')
  expect(bundle.rulesYaml).not.toContain(token)
  expect(bundle.alertmanagerYaml).not.toContain('telegram_configs')
  await expect(modal.getByRole('alert').filter({ hasText: 'Configuration prepared' })).toBeVisible()
  const download = page.waitForEvent('download')
  await modal.getByRole('button', { name: 'Download rules.yaml' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('rules.yaml')
  const stream = await file.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).toString()).toBe(bundle.rulesYaml)
  await modal.getByRole('combobox', { name: 'Deployment' }).click()
  await page.getByRole('option', { name: 'Kubernetes · VM Operator' }).click()
  await expect(modal.getByText('kind: VMRule', { exact: false })).toBeVisible()
  await modal.getByLabel('Include a new Telegram receiver template').check()
  await expect(modal.getByText('Settings changed. Prepare the configuration again.')).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Download vmrule.yaml' })).toHaveCount(0)
  await modal.getByRole('button', { name: 'Prepare configuration' }).click()
  await modal.getByRole('tab', { name: 'Alertmanager fragment' }).click()
  await expect(modal.locator('pre:visible')).toContainText('REPLACE_WITH_NUMERIC_CHAT_ID')
  await expect(modal.locator('pre:visible')).toContainText('bot_token_file:')
  await modal.getByRole('tab', { name: 'Setup instructions' }).click()
  await expect(modal.locator('pre:visible')).toContainText('systemd')
  await expect(modal.locator('pre:visible')).toContainText('no shared volume')
  await modal.getByLabel('Public Errotel URL').fill('javascript:alert(1)')
  await expect(modal.getByRole('button', { name: 'Prepare configuration' })).toBeDisabled()
  await expect(modal.getByRole('alert').filter({ hasText: 'public http(s)' })).toBeVisible()
  expect(external).toEqual([])
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
  await page.screenshot({ path: 'test-results/alert-generator.png', fullPage: true })
})

test('alert preview response fixtures: partial, cache and unavailable stay explicit', async ({
  page,
}) => {
  await start()
  let mode: 'partial' | 'cache' | 'failure' = 'partial'
  await page.route('**/api/v1/occurrences/histogram', async (route) => {
    if (mode === 'failure') {
      await route.fulfill({
        status: 503,
        json: { code: 'upstream_unavailable', message: 'upstream unavailable' },
      })
      return
    }
    const range = route.request().postDataJSON().range
    await route.fulfill({
      json: {
        range,
        intervalMs: 300000,
        buckets: [],
        total: mode === 'partial' ? 10 : 0,
        meta: {
          queryStatus: mode === 'partial' ? 'partial' : 'complete',
          servedFrom: mode === 'cache' ? 'cache' : 'upstream',
          fetchedAt: '2026-09-10T10:00:00Z',
          cacheAgeMs: mode === 'cache' ? 200 : undefined,
          warnings: mode === 'partial' ? ['upstream_partial'] : [],
        },
      },
    })
  })
  await connectUI(page, '#/')
  await page.getByRole('button', { name: 'Configure alert', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Configure external alert' })
  await modal.getByRole('button', { name: 'Preview current count' }).click()
  await expect(modal.getByRole('alert')).toContainText(
    '10 errors in partial data · condition unknown'
  )
  await expect(modal.getByRole('alert')).toContainText('upstream_partial')
  mode = 'cache'
  await modal.getByRole('button', { name: 'Preview current count' }).click()
  await expect(modal.getByRole('alert')).toContainText('0 matching errors · condition not met')
  await expect(modal.getByRole('alert')).toContainText('cache age 200ms')
  mode = 'failure'
  await modal.getByRole('button', { name: 'Preview current count' }).click()
  await expect(modal.getByRole('alert')).toContainText('upstream unavailable')
  await expect(modal.getByText('0 matching errors', { exact: false })).toHaveCount(0)
  // Preparing YAML does not depend on the preview upstream being available.
  await modal.getByRole('button', { name: 'Prepare configuration' }).click()
  await expect(modal.getByRole('button', { name: 'Download rules.yaml' })).toBeVisible()
})

test('durable IndexedDB: offline browser restart → real protobuf → VM → investigation', async () => {
  test.setTimeout(150_000)
  await start()
  const profile = join(directory, 'durable-profile')
  const name = `durable-${crypto.randomUUID()}`
  const modulePath = `/@fs/${root}/tests/browser/outbox-fixture.ts`
  let browser = await chromium.launchPersistentContext(profile, { headless: true })
  try {
    let page = await browser.newPage()
    await page.goto('http://127.0.0.1:14173')
    await page.evaluate(
      async ({ modulePath, name }) => {
        const { outboxFixture } = await import(modulePath)
        window.outboxFixture = outboxFixture(name, 'http://127.0.0.1:14318/v1/logs')
      },
      { modulePath, name }
    )
    await browser.setOffline(true)
    const captured = await page.evaluate(async () => {
      const result = window.outboxFixture.capture(80_000)
      await window.outboxFixture.client.outbox?.flushStorage()
      return {
        result,
        stats: await window.outboxFixture.client.outbox?.stats(),
        stamp: String(BigInt(Date.now()) * 1_000_000n),
      }
    })
    expect(captured.result.status).toBe('emitted')
    if (captured.result.status !== 'emitted') throw new Error('capture failed')
    expect(captured.stats?.entries).toBe(1)
    // Close the actual browser without SDK shutdown. The acknowledged IDB transaction survives.
    await browser.close()
    browser = await chromium.launchPersistentContext(profile, { headless: true })
    page = await browser.newPage()
    await page.goto('http://127.0.0.1:14173')
    await page.evaluate(
      async ({ modulePath, name }) => {
        const { outboxFixture } = await import(modulePath)
        window.outboxFixture = outboxFixture(name, 'http://127.0.0.1:14318/v1/logs')
      },
      { modulePath, name }
    )
    const selector = {
      eventId: captured.result.eventId,
      range: {
        startUnixNano: String(BigInt(captured.stamp) - 60_000_000_000n),
        endUnixNano: String(BigInt(captured.stamp) + 1_000_000_000n),
      },
    }
    await expect
      .poll(async () => (await api('investigate', selector)).status, { timeout: 65_000 })
      .toBe(200)
    const bundle: InvestigationResponse = await api('investigate', selector).then((r) => r.json())
    expect(bundle.occurrence.summary.service).toBe(name)
    expect(bundle.occurrence.summary.eventId).toBe(captured.result.eventId)
    expect(bundle.occurrence.summary.traceId).toBe('a'.repeat(32))
    expect(bundle.occurrence.payload.status).toBe('available')
    if (bundle.occurrence.payload.status !== 'available') throw new Error('missing durable payload')
    const payload = bundle.occurrence.payload.value
    expect(payload.exception.stacktrace).toBe('original stack\n  <script>untrusted</script>')
    expect(payload.trace?.traceFlags).toBe(0)
    expect(payload.state.sources[0]).toMatchObject({ status: 'ok', value: { revision: 2 } })
    expect(payload.history.items[1]).toMatchObject({
      kind: 'state',
      snapshot: { value: { revision: 1 } },
    })
    expect(bundle.occurrence.warnings).toEqual([])
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.outboxFixture.client.outbox?.stats())?.entries)
      )
      .toBe(0)
    await connectUI(page, `#/occurrences/${bundle.occurrence.summary.ref}`)
    await expect(page.getByTestId('stacktrace')).toHaveText(payload.exception.stacktrace ?? '')
    await stop()
    await start()
    const after: InvestigationResponse = await api('investigate', {
      ref: bundle.occurrence.summary.ref,
    }).then((r) => r.json())
    expect(after.occurrence).toEqual(bundle.occurrence)
  } finally {
    await browser.close()
  }
})

test('published API docs, real facet suggestions and secret-free agent handoff', async ({
  page,
}) => {
  await start()
  await page.goto('http://127.0.0.1:14173')
  await page.waitForFunction(() => typeof window.runScenario === 'function')
  const captured = await page.evaluate(() => window.runScenario())
  const rootResponse = await fetch(url)
  expect(rootResponse.headers.get('link')).toContain('agent.md')
  const spec = await fetch(`${url}/openapi.json`).then((r) => r.json())
  expect(spec.paths['/api/v1/facets'].post.operationId).toBe('getFacets')
  const guide = await fetch(`${url}/agent.md`).then((r) => r.text())
  expect(guide).toContain('serverTimeUnixNano')
  expect(guide).not.toContain(token)
  const stamp = BigInt(captured.envelope.timestampUnixNano)
  const selector = {
    service: captured.service,
    range: { startUnixNano: String(stamp - 1n), endUnixNano: String(stamp + 1n) },
  }
  await expect
    .poll(
      async () => {
        const response = await api('occurrences/search', selector)
        expect(response.status).toBe(200)
        return (await response.json()).items.length
      },
      { timeout: 20_000 }
    )
    .toBe(1)
  const query = `time:[now-15m TO now} AND service:"${captured.service}"`
  await connectUI(page, `#/?q=${encodeURIComponent(query)}`)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(window as unknown as { copiedInstruction: string }).copiedInstruction = value
        },
      },
    })
  })
  const editor = page.getByRole('textbox', { name: 'Search query' })
  await expect(page.getByRole('button', { name: /^SyntheticError / }).first()).toBeVisible({
    timeout: 20000,
  })
  await page.getByRole('button', { name: 'Add filter', exact: true }).click()
  await page.getByRole('textbox', { name: 'Value', exact: true }).fill(captured.service)
  const values = page.getByRole('region', { name: 'Observed filter values' })
  await expect(values.getByRole('button', { name: `${captured.service} 1 errors` })).toBeVisible({
    timeout: 10000,
  })
  await values.getByRole('button', { name: `${captured.service} 1 errors` }).click()
  await expect(editor).not.toHaveText(query)
  await page.getByRole('button', { name: 'Undo query', exact: true }).click()
  await expect(editor).toHaveText(query)
  await page.getByRole('button', { name: 'API / Agent', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Connect an investigation agent' })
  await expect(modal.getByRole('textbox', { name: 'Instruction preview' })).toHaveValue(/"search"/)
  await modal.getByRole('button', { name: 'Copy instruction for agent' }).click()
  const copied = await page.evaluate(
    () => (window as unknown as { copiedInstruction: string }).copiedInstruction
  )
  expect(copied).not.toContain(token)
  expect(copied).not.toContain('"pageSize"')
  expect(copied).toContain(captured.service)
  expect(copied).toContain(`${url}/agent.md`)
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  )
  await modal.getByRole('button', { name: 'Copied instruction', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('Clipboard unavailable')
  await modal
    .getByRole('textbox', { name: 'ErrOtel service URL' })
    .fill('https://example/?token=secret')
  await expect(modal.getByRole('button', { name: 'Copy instruction for agent' })).toBeDisabled()
  await page.keyboard.press('Escape')
  const search = await api('occurrences/search', selector).then((r) => r.json())
  await page.goto(`${url}/#/occurrences/${search.items[0].ref}`)
  await page.getByRole('button', { name: 'API / Agent', exact: true }).click()
  await expect(modal.getByRole('textbox', { name: 'Instruction preview' })).toHaveValue('') // invalid URL persists until corrected
  await modal.getByRole('textbox', { name: 'ErrOtel service URL' }).fill(url)
  await expect(modal.getByRole('textbox', { name: 'Instruction preview' })).toHaveValue(
    new RegExp(search.items[0].ref)
  )
})
