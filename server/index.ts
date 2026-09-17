import { createBrowserApp } from './browser-app.js'

const app = createBrowserApp()
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
await app.listen({ host, port })
console.log(`Pencil AI relay: http://${host}:${port}; workspace storage stays in each browser.`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); process.exit(0) })
}
