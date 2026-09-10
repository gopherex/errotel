import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: resolve('app/vite.config.ts'),
  root: resolve('app'),
  cacheDir: resolve('.cache/vite-dev-smoke'),
  server: { host: '127.0.0.1', port: 0, open: false },
})
let browser
try {
  await server.listen()
  // A dev session must resolve workspace source even without a package dist build.
  const resolved =
    await server.environments.client.pluginContainer.resolveId('@gopherex/errotel-api')
  assert.equal(resolved?.id, resolve('packages/api/src/index.ts'))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0])
  await page.getByLabel(/^API token/).waitFor()
  await page.getByRole('button', { name: 'API / Agent', exact: true }).waitFor()
  await page.evaluate(async (path) => {
    await import(path)
  }, '/src/testTelemetry.ts')
  assert.deepEqual(errors, [])
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  console.log('Vite dev: workspace source resolution and browser rendering OK')
} finally {
  await browser?.close()
  await server.close()
}
