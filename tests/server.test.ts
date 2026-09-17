import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Store } from '../server/store.js'
import { createApp } from '../server/app.js'
import { runAgent, type Provider } from '../server/agent.js'
import { blankDeck } from '../src/document.js'
import type Anthropic from '@anthropic-ai/sdk'

test('SQLite saves atomically, survives reopen and enforces revision/idempotency', () => {
  mkdirSync('data', { recursive: true })
  const path = `data/test-${randomUUID()}.sqlite`
  let store = new Store(path)
  try {
    const deck = store.create(blankDeck())
    const modified = { ...deck.snapshot, title: 'Persistent' }
    assert.deepEqual(store.save(deck.id, 0, modified, 'once'), { revision: 1 })
    assert.deepEqual(store.save(deck.id, 0, modified, 'once'), { revision: 1 })
    assert.throws(() => store.save(deck.id, 0, modified, 'stale'), /Revision conflict/)
    assert.throws(() => store.save(deck.id, 1, { ...modified, title: 'Other' }, 'once'), /already used/)
    store.append(deck.id, 'user', 'Preserve this older conversation')
    store.db.exec('ALTER TABLE chat DROP COLUMN details')
    store.close()
    store = new Store(path)
    assert.equal(store.get(deck.id).snapshot.title, 'Persistent')
    assert.equal(store.get(deck.id).revision, 1)
    assert.equal(store.messages(deck.id)[0]!.content, 'Preserve this older conversation')
    const details = { activities: [{ id: 'read-1', name: 'read_context', status: 'complete' as const }], artifacts: [{ title: 'Persistent', revision: 1, slideIds: modified.slides.map(s => s.id) }] }
    store.append(deck.id, 'assistant', 'Saved', details)
    store.close()
    store = new Store(path)
    assert.deepEqual(store.messages(deck.id).at(-1)!.artifacts, details.artifacts)
    assert.deepEqual(store.messages(deck.id).at(-1)!.activities, details.activities)
  } finally {
    store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
})

test('localhost API rejects foreign origins and validates payloads', async () => {
  const store = new Store(':memory:')
  const app = createApp(store)
  try {
    assert.equal((await app.inject({ url: '/api/health', headers: { host: 'attacker.example' } })).statusCode, 403)
    assert.equal((await app.inject({ url: '/api/health', headers: { host: '127.0.0.1', origin: 'https://evil.example' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/decks', payload: {} })).statusCode, 400)
  } finally { await app.close(); store.close() }
})

const tool = (name: string, input: unknown): Anthropic.ToolUseBlock => ({ type: 'tool_use', id: randomUUID(), name, input, caller: { type: 'direct' } })

test('mocked streamed provider waits for durable browser acknowledgement, persists chat, returns real failure', async () => {
  const store = new Store(':memory:')
  const deck = store.create(blankDeck())
  let round = 0
  const provider: Provider = async (messages, _signal, text) => {
    const last = messages.at(-1)?.content
    if (round === 1) assert.match(JSON.stringify(last), /selectedIds/)
    if (round === 2) assert.match(JSON.stringify(last), /acknowledged without a durable save/)
    if (round === 3) {
      const result = (last as Anthropic.ToolResultBlockParam[])[0]!
      assert.equal(JSON.parse(result.content as string).data.revision, 1)
    }
    switch (round++) {
      case 0: return [tool('read_context', { view: 'selection' })]
      case 1: return [tool('apply_batch', { expectedRevision: 0, operations: [{ op: 'update_slide', id: deck.snapshot.slides[0]!.id, title: 'Updated' }] })]
      case 2: return [tool('apply_batch', { expectedRevision: 0, operations: [{ op: 'update_slide', id: deck.snapshot.slides[0]!.id, title: 'Updated' }] })]
      default: text('Saved the change.'); return [{ type: 'text', text: 'Saved the change.', citations: null }]
    }
  }
  const app = createApp(store, provider)
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const response = await fetch(`${address}/api/decks/${deck.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Update selected slide' }) })
    assert.equal(response.status, 200)
    let runId = '', buffer = '', mutations = 0, doneEvent = false
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const event = packet.match(/^event: (.+)$/m)?.[1], raw = packet.match(/^data: (.+)$/m)?.[1]
        if (!raw) continue
        const data = JSON.parse(raw)
        if (event === 'error') assert.fail(data.error)
        if (event === 'run') runId = data.id
        if (event === 'done') doneEvent = true
        if (event !== 'command') continue
        if (data.name === 'apply_batch' && ++mutations === 2) {
          const updated = structuredClone(deck.snapshot)
          updated.slides[0]!.title = 'Updated'
          const saved = await fetch(`${address}/api/decks/${deck.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 0, commandId: data.id, snapshot: updated }),
          })
          assert.equal(saved.status, 200)
        }
        const ack = await fetch(`${address}/api/runs/${runId}/commands/${data.id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: true, data: data.name === 'read_context' ? { revision: 0, selectedIds: ['selected-text'] } : {} }),
        })
        assert.equal(ack.status, 200)
      }
      if (done) break
    }
    assert.ok(doneEvent)
    assert.equal(store.get(deck.id).revision, 1)
    assert.equal(store.messages(deck.id).at(-1)!.content, 'Saved the change.')
    assert.deepEqual(store.messages(deck.id).at(-1)!.activities!.map(a => a.status), ['complete', 'failed', 'complete'])
    assert.equal(store.messages(deck.id).at(-1)!.artifacts!.length, 1)
    assert.equal(store.messages(deck.id).at(-1)!.artifacts![0]!.revision, 1)
  } finally { await app.close(); store.close() }
})

test('agent bounds loops, rejects unsupported tools and observes cancellation', async () => {
  const controller = new AbortController()
  const events: unknown[] = []
  let executions = 0
  await assert.rejects(runAgent({
    provider: async () => [tool('shell', { command: 'no' })],
    messages: [{ role: 'user', content: 'test' }], signal: controller.signal,
    emit: (_event, data) => events.push(data),
    execute: async () => { executions++; return { ok: true } },
  }), /Tool limit reached \(30\)/)
  assert.equal(executions, 0)
  assert.equal(events.length, 30)
  assert.match(JSON.stringify(events), /Unsupported tool/)
  controller.abort()
  await assert.rejects(runAgent({ provider: async () => [], messages: [], signal: controller.signal, emit: () => {}, execute: async () => ({ ok: true }) }))
})

test('cancellation endpoint aborts the provider and rejects late AI writes', async () => {
  const store = new Store(':memory:')
  const deck = store.create(blankDeck())
  let aborted = false
  const provider: Provider = async (_messages, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })
  })
  const app = createApp(store, provider)
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const response = await fetch(`${address}/api/decks/${deck.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Wait' }),
    })
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    const runId = JSON.parse(first.match(/^data: (.+)$/m)![1]!).id
    const cancel = await fetch(`${address}/api/runs/${runId}/cancel`, { method: 'POST' })
    assert.equal(cancel.status, 200)
    let rest = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      rest += new TextDecoder().decode(value)
    }
    assert.ok(aborted)
    assert.match(rest, /Cancelled by user/)
    const late = await app.inject({
      method: 'PUT', url: `/api/decks/${deck.id}`,
      payload: { expectedRevision: 0, commandId: 'ai:expired', snapshot: deck.snapshot },
    })
    assert.equal(late.statusCode, 409)
    assert.equal(store.get(deck.id).revision, 0)
  } finally { await app.close(); store.close() }
})
