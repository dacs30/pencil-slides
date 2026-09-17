import { mkdirSync } from 'node:fs'
import { Store } from './store.js'
import { createApp } from './app.js'

mkdirSync('data', { recursive: true })
const store = new Store('data/pencil-slides.sqlite')
const app = createApp(store)
const port = Number(process.env.PORT || 3001)
await app.listen({ host: '127.0.0.1', port })
console.log(`Pencil Slides API: http://127.0.0.1:${port}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); store.close(); process.exit(0) })
}
