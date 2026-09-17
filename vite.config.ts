import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const coreDependencies = Object.keys(require('@open-pencil/core/package.json').dependencies)
  .filter(name => !name.startsWith('@open-pencil/'))

export default defineConfig({
  plugins: [
    {
      name: 'open-pencil-published-worker-urls',
      enforce: 'pre',
      transform(code, id) {
        // 0.15.0 publishes JS workers but retains .ts URLs in three emitted clients.
        if (!id.includes('/@open-pencil/core/dist/')) return
        return code.replace(/new URL\("(\.\/(?:export-)?worker)\.ts", import\.meta\.url\)/g, 'new URL("$1.js", import.meta.url)')
      },
    },
    vue(),
  ],
  optimizeDeps: {
    exclude: ['@open-pencil/core', '@open-pencil/vue'],
    include: [...coreDependencies, 'source-map-js', 'source-map-js/lib/source-map-generator.js', 'canvaskit-wasm/full'],
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
    fs: { strict: true },
  },
})
