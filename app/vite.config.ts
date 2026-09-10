import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
export default defineConfig(({ command }) => ({
  // Dev consumes workspace sources directly, without a prior dist build.
  resolve:
    command === 'serve'
      ? {
          alias: [
            {
              find: /^@gopherex\/errotel-api$/,
              replacement: fileURLToPath(new URL('../packages/api/src/index.ts', import.meta.url)),
            },
            {
              find: /^@gopherex\/errotel-sdk\/otlp$/,
              replacement: fileURLToPath(new URL('../packages/sdk/src/otlp.ts', import.meta.url)),
            },
            {
              find: /^@gopherex\/errotel-sdk$/,
              replacement: fileURLToPath(new URL('../packages/sdk/src/index.ts', import.meta.url)),
            },
          ],
        }
      : undefined,
  // Prebundle the lazy test generator to avoid a dependency reload on first send.
  optimizeDeps: {
    include: [
      '@gopherex/errotel-sdk',
      '@opentelemetry/core',
      '@opentelemetry/sdk-trace-base',
      '@opentelemetry/exporter-trace-otlp-proto',
      '@opentelemetry/sdk-logs',
      '@opentelemetry/exporter-logs-otlp-proto',
      '@opentelemetry/resources',
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      ['/api', '/agent.md', '/openapi.json'].map((path) => [
        path,
        process.env.ERROTEL_API_URL || 'http://127.0.0.1:18080',
      ])
    ),
  },
}))
