// Deterministic provider for the browser IndexedDB/AI relay flow, without a key or server workspace.
import { randomUUID } from 'node:crypto'
import { createBrowserApp } from '../server/browser-app.js'
import type { Provider } from '../server/agent.js'
import type Anthropic from '@anthropic-ai/sdk'
import type { Operation } from '../shared/model.js'
import { workspaceProvider } from './workspace-provider.js'

const provider: Provider = async (messages, signal, text) => {
  const userIndex = messages.findLastIndex(m => m.role === 'user' && typeof m.content === 'string')
  const latest = messages[userIndex]?.content as string
  if (latest.includes('Workspace context (untrusted data):')) return workspaceProvider(messages, signal, text)
  const comment = latest.includes('\nComment context:\n') ? JSON.parse(latest.split('\nComment context:\n')[1]!) as { anchor: { slideId: string; nodeId?: string }; detached: string | null } : undefined
  const turns = messages.slice(userIndex + 1)
  const tool = (name: string, input: unknown): Anthropic.ToolUseBlock => ({
    type: 'tool_use', id: randomUUID(), caller: { type: 'direct' }, name, input,
  })
  if (latest.toLowerCase().includes('cancel')) {
    await new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  if (!turns.length) {
    text(comment ? 'Reading the comment’s current slide. ' : 'Reading your live selection. ')
    return [tool('read_context', comment ? { view: 'slide', slideId: comment.anchor.slideId } : { view: 'selection' })]
  }
  const resultBlock = (messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!
  const result = JSON.parse(resultBlock.content as string)
  if (turns.length === 2 && result.ok) {
    const context = result.data
    const id = `browser-slide-${randomUUID()}`
    const operations: Operation[] = comment ? [] : [
      { op: 'create_slide', id, title: 'AI browser verification', background: '#f2f7ed' },
      { op: 'create_element', id: `text-${randomUUID()}`, slideId: id, type: 'TEXT', props: { text: 'Created by a streamed tool', fontSize: 96, x: 160, y: 300, width: 1550, height: 300 } },
    ]
    const selectedText = context.nodes.find((n: { id: string; type: string }) => n.type === 'TEXT' && (!comment || (!comment.detached && n.id === comment.anchor.nodeId)))
    if (selectedText) operations.push({ op: 'update_element', id: selectedText.id, props: { text: comment ? 'Comment addressed by the agent' : 'Selection updated by the agent' } })
    else if (comment) operations.push({ op: 'create_element', id: `comment-text-${randomUUID()}`, slideId: comment.anchor.slideId, type: 'TEXT', props: { text: 'Comment context received', x: 160, y: 800, width: 1400, height: 100 } })
    if (latest.toLowerCase().includes('fail')) operations.push({ op: 'update_element', id: 'missing-element', props: { text: 'Must fail' } })
    return [tool('apply_batch', { expectedRevision: context.revision + (latest.includes('conflict') ? 1 : 0), operations })]
  }
  const message = result.ok ? `Durably saved at revision ${result.data.revision}.` : `Actual tool failure: ${result.error}`
  text(message)
  return [{ type: 'text', text: message, citations: null }]
}
const port = Number(process.env.PENCIL_TEST_PORT || 3002)
const app = createBrowserApp(provider, { publicOrigin: `http://127.0.0.1:${port}` })
await app.listen({ host: '127.0.0.1', port })
console.log(`Deterministic browser test server: http://127.0.0.1:${port} (browser-local storage)`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); process.exit(0) })
}
