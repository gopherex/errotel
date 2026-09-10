import { chromium } from '@playwright/test'

const url = process.env.ERROTEL_EXAMPLE_URL ?? 'http://127.0.0.1:14173'
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Synthetic seed requires a local example URL')
}
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  page.on('pageerror', (error) => process.stderr.write(`${error.message}\n`))
  await page.goto(url)
  await page.waitForFunction(() => typeof window.runScenario === 'function')
  const result = await page.evaluate(() => window.runScenario({ seedCases: true }))
  process.stdout.write(
    `${JSON.stringify({ eventId: result.eventId, traceId: result.traceId, service: result.service, cases: result.cases }, null, 2)}\n`
  )
} finally {
  await browser.close()
}
