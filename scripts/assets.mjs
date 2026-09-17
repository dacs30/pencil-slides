import { mkdirSync, copyFileSync, readdirSync } from 'node:fs'
mkdirSync('public', { recursive: true })
copyFileSync('node_modules/canvaskit-wasm/bin/canvaskit.wasm', 'public/canvaskit.wasm')
for (const file of readdirSync('node_modules/@open-pencil/core/assets')) {
  if (file.endsWith('.ttf')) copyFileSync(`node_modules/@open-pencil/core/assets/${file}`, `public/${file}`)
}
