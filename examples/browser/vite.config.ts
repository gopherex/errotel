import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(import.meta.dirname),
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: {
    host: '127.0.0.1',
    port: 14173,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
  },
  build: { outDir: '../../.cache/example-dist', emptyOutDir: true },
})
