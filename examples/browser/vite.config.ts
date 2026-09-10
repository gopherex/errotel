import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(import.meta.dirname),
  server: {
    host: '127.0.0.1',
    port: 14173,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
  },
  build: { outDir: '../../.cache/example-dist', emptyOutDir: true },
})
