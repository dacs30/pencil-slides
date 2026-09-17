import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { SceneGraph } from '@open-pencil/scene-graph'
import type Anthropic from '@anthropic-ai/sdk'
import { Store } from '../server/store.js'
import { CommentStore } from '../server/comments.js'
import { createApp } from '../server/app.js'
import type { Provider } from '../server/agent.js'
import { sampleDeck, restore, snapshot } from '../src/document.js'
import { objectPointOnSlide, resolveCommentAnchor, screenToSlidePoint, slidePointToViewport } from '../src/comment-geometry.js'
import { createCommentSchema, type CommentThread } from '../shared/comments.js'

test('comment storage preserves threads/replies, retries, resolve/reopen and limits without artwork changes', () => {
  mkdirSync('data', { recursive: true })
  const path = `data/comments-test-${randomUUID()}.sqlite`
  let store = new Store(path)
  try {
    const deck = store.create(sampleDeck())
    let comments = new CommentStore(store)
    const input = { id: randomUUID(), expectedRevision: 0, anchor: { kind: 'point', slideId: deck.snapshot.slides[0]!.id, x: 120, y: 220 }, body: "  Please improve this. '; DROP TABLE decks; --  " }
    const thread = comments.create(deck.id, input)
    assert.equal(thread.messages[0]!.body, input.body.trim())
    assert.equal(comments.create(deck.id, input).id, thread.id)
    assert.equal(comments.list(deck.id).length, 1)
    const reply = { id: randomUUID(), expectedVersion: 1, body: 'A useful reply' }
    assert.equal(comments.reply(deck.id, thread.id, reply).version, 2)
    assert.equal(comments.reply(deck.id, thread.id, reply).messages.length, 2)
    assert.throws(() => comments.reply(deck.id, thread.id, { ...reply, body: 'Different content' }), /already used/)
    const resolved = comments.resolve(deck.id, thread.id, { expectedVersion: 2, resolved: true })
    assert.equal(resolved.resolved, true)
    assert.equal(comments.resolve(deck.id, thread.id, { expectedVersion: 2, resolved: true }).version, 3)
    assert.throws(() => comments.reply(deck.id, thread.id, { id: randomUUID(), expectedVersion: 3, body: 'Cannot reply yet' }), /Reopen/)
    assert.throws(() => comments.handoff(deck.id, thread.id, 3), /Reopen/)
    assert.equal(comments.resolve(deck.id, thread.id, { expectedVersion: 3, resolved: false }).version, 4)
    assert.throws(() => comments.resolve(deck.id, thread.id, { expectedVersion: 2, resolved: true }), /Thread changed/)
    assert.equal(store.get(deck.id).revision, 0)
    assert.deepEqual(store.get(deck.id).snapshot, deck.snapshot)
    store.close()
    store = new Store(path); comments = new CommentStore(store)
    const restored = comments.get(deck.id, thread.id)
    assert.equal(restored.resolved, false)
    assert.equal(restored.version, 4)
    assert.equal(restored.messages.length, 2)
    assert.deepEqual(restored.anchor, thread.anchor)
    assert.throws(() => createCommentSchema.parse({ ...input, body: ' '.repeat(20) }))
    assert.throws(() => createCommentSchema.parse({ ...input, body: 'x'.repeat(2001) }))
    assert.throws(() => createCommentSchema.parse({ ...input, anchor: { ...input.anchor, x: -1 } }))
    assert.throws(() => createCommentSchema.parse({ ...input, anchor: { ...input.anchor, y: Number.NaN } }))
  } finally {
    store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
})

test('object anchors retain original fallback coordinates and detach permanently on durable deletion/ID reuse', () => {
  const store = new Store(':memory:')
  try {
    const data = sampleDeck()
    const graph = new SceneGraph(); restore(graph, data)
    const second = graph.createNode('FRAME', data.pageId, { id: 'second-slide', width: 1920, height: 1080, x: 2120 })
    const meta = { title: data.title, pageId: data.pageId, slides: [...data.slides, { id: second.id, title: 'Second' }] }
    const initial = snapshot(graph, meta)
    const deck = store.create(initial), comments = new CommentStore(store)
    const title = graph.getChildren(data.slides[0]!.id).find(n => n.type === 'TEXT')!
    const thread = comments.create(deck.id, { id: randomUUID(), expectedRevision: 0, anchor: { kind: 'object', slideId: data.slides[0]!.id, nodeId: title.id }, body: 'Make this title clearer' })
    const fallback = { x: thread.anchor.x, y: thread.anchor.y }
    graph.updateNode(title.id, { x: title.x + 180 })
    store.save(deck.id, 0, snapshot(graph, meta), randomUUID())
    const moved = comments.get(deck.id, thread.id)
    assert.deepEqual({ x: moved.anchor.x, y: moved.anchor.y }, fallback)
    assert.equal(resolveCommentAnchor(graph, moved).point!.x, fallback.x + 180)
    graph.deleteNode(title.id)
    store.save(deck.id, 1, snapshot(graph, meta), randomUUID())
    assert.equal(comments.get(deck.id, thread.id).detached, 'object_deleted')
    restore(graph, initial)
    store.save(deck.id, 2, snapshot(graph, meta), randomUUID())
    const detached = comments.get(deck.id, thread.id)
    assert.equal(detached.detached, 'object_deleted')
    assert.deepEqual(resolveCommentAnchor(graph, detached).point, fallback)
    assert.match(comments.handoff(deck.id, thread.id, detached.version).content, /object_deleted/)
    graph.deleteNode(data.slides[0]!.id)
    store.save(deck.id, 3, snapshot(graph, { ...meta, slides: [{ id: second.id, title: 'Second' }] }), randomUUID())
    const missingSlide = comments.get(deck.id, thread.id)
    assert.equal(missingSlide.detached, 'slide_deleted')
    assert.equal(resolveCommentAnchor(graph, missingSlide).point, null)
    assert.throws(() => comments.handoff(deck.id, thread.id, missingSlide.version), /deleted slide/)
    restore(graph, initial)
    store.save(deck.id, 4, snapshot(graph, meta), randomUUID())
    assert.equal(resolveCommentAnchor(graph, comments.get(deck.id, thread.id)).point, null, 'Restored/reused slide ID must not silently reattach')
  } finally { store.close() }
})

test('pin coordinate math respects actual origin, pan, zoom, nested rotations and object movement', () => {
  const graph = new SceneGraph()
  const slide = graph.createNode('FRAME', graph.getPages()[0]!.id, { x: 2120, y: 300, width: 1920, height: 1080, rotation: 15 })
  const group = graph.createNode('GROUP', slide.id, { x: 120, y: 80, width: 500, height: 300, rotation: 30 })
  const node = graph.createNode('RECTANGLE', group.id, { x: 40, y: 50, width: 100, height: 60, rotation: 45 })
  const point = objectPointOnSlide(graph, node.id, slide.id)!
  assert.ok(Math.abs(point.x - (370 - 160 * Math.cos(Math.PI / 6) + 35)) < 0.001)
  assert.ok(Math.abs(point.y - (230 - 80 - 70 * Math.cos(Math.PI / 6))) < 0.001)
  const rect = { left: 431, top: 177 }
  for (const zoom of [0.25, 0.5, 1.75]) {
    const view = { panX: -1200, panY: 48, zoom }
    const position = slidePointToViewport(graph, slide.id, point, view)!
    const restored = screenToSlidePoint(graph, slide.id, { x: position.x + rect.left, y: position.y + rect.top }, rect, view)!
    assert.ok(Math.abs(restored.x - point.x) <= 0.01)
    assert.ok(Math.abs(restored.y - point.y) <= 0.01)
    const outside = slidePointToViewport(graph, slide.id, { x: -10, y: 100 }, view)!
    assert.equal(screenToSlidePoint(graph, slide.id, { x: outside.x + rect.left, y: outside.y + rect.top }, rect, view), null)
  }
  graph.updateNode(node.id, { x: 140 })
  const shifted = objectPointOnSlide(graph, node.id, slide.id)!
  assert.ok(Math.abs(shifted.x - point.x - 100 * Math.cos(Math.PI / 6)) < 0.001)
  assert.ok(Math.abs(shifted.y - point.y - 50) < 0.001)
  assert.equal(screenToSlidePoint(graph, slide.id, { x: 0, y: 0 }, rect, { panX: 0, panY: 0, zoom: 0 }), null)
})

test('comment API rejects malformed, missing and cross-deck anchors with explicit errors', async () => {
  const store = new Store(':memory:'), app = createApp(store)
  try {
    const first = store.create(sampleDeck()), second = store.create(sampleDeck())
    const body = { id: randomUUID(), expectedRevision: 0, anchor: { kind: 'point', slideId: first.snapshot.slides[0]!.id, x: 20, y: 30 }, body: 'Comment' }
    assert.equal((await app.inject({ method: 'POST', url: `/api/decks/${first.id}/comments`, payload: { ...body, id: 'bad' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: `/api/decks/${first.id}/comments`, payload: { ...body, anchor: { kind: 'object', slideId: body.anchor.slideId, nodeId: 'missing' } } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url: `/api/decks/${second.id}/comments`, payload: body })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url: `/api/decks/${first.id}/comments`, payload: { ...body, expectedRevision: 10 } })).statusCode, 409)
    const created = (await app.inject({ method: 'POST', url: `/api/decks/${first.id}/comments`, payload: body })).json() as CommentThread
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/decks/${second.id}/comments/${created.id}`, payload: { expectedVersion: 1, resolved: true } })).statusCode, 404)
    assert.equal((await app.inject({ url: '/api/decks/not-a-uuid/comments' })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: `/api/decks/${first.id}/chat`, payload: { message: 'Ask', commentThreadId: created.id } })).statusCode, 400)
  } finally { await app.close(); store.close() }
})

test('AI handoff is explicit, carries untrusted thread context, requires a fresh slide read and never auto-resolves', async () => {
  const store = new Store(':memory:')
  const deck = store.create(sampleDeck()), comments = new CommentStore(store)
  const slideId = deck.snapshot.slides[0]!.id
  const target = deck.snapshot.nodes.find(n => n.type === 'TEXT')!
  const thread = comments.create(deck.id, { id: randomUUID(), expectedRevision: 0, anchor: { kind: 'object', slideId, nodeId: target.id }, body: 'PRIVATE_COMMENT_ONLY: Please tighten the title.' })
  let round = 0
  let normalChecked = false
  const tool = (name: string, input: unknown): Anthropic.ToolUseBlock => ({ type: 'tool_use', id: randomUUID(), name, input, caller: { type: 'direct' } })
  const provider: Provider = async (messages, _signal, text) => {
    const request = messages.findLast(m => m.role === 'user' && typeof m.content === 'string')!.content as string
    if (request === 'Just chat') {
      assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_COMMENT_ONLY/)
      normalChecked = true; text('No comments read.'); return [{ type: 'text', text: 'No comments read.', citations: null }]
    }
    assert.match(request, /PRIVATE_COMMENT_ONLY/)
    assert.match(request, /untrusted comment\/context data/)
    assert.match(request, /Do not resolve/)
    if (round === 1) assert.match(JSON.stringify(messages.at(-1)), /Read current slide context first/)
    if (round === 0 || round === 2) {
      round++
      return [tool('apply_batch', { expectedRevision: 0, operations: [{ op: 'update_element', id: target.id, props: { text: 'Updated from comment' } }] })]
    }
    if (round++ === 1) return [tool('read_context', { view: 'slide', slideId })]
    text('Saved the requested edit.'); return [{ type: 'text', text: 'Saved the requested edit.', citations: null }]
  }
  const app = createApp(store, provider), address = await app.listen({ host: '127.0.0.1', port: 0 })
  let applied = 0, read = 0
  try {
    await (await fetch(`${address}/api/decks/${deck.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Just chat' }) })).text()
    assert.ok(normalChecked)
    const response = await fetch(`${address}/api/decks/${deck.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Address this comment', commentThreadId: thread.id, expectedCommentVersion: thread.version }) })
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let runId = '', buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const event = packet.match(/^event: (.+)$/m)?.[1], raw = packet.match(/^data: (.+)$/m)?.[1]
        if (!raw) continue
        const data = JSON.parse(raw)
        if (event === 'error') assert.fail(data.error)
        if (event === 'run') runId = data.id
        if (event !== 'command') continue
        if (data.name === 'apply_batch') {
          applied++
          const updated = structuredClone(deck.snapshot)
          updated.nodes.find(n => n.id === target.id)!.text = 'Updated from comment'
          const save = await fetch(`${address}/api/decks/${deck.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, commandId: data.id, snapshot: updated }) })
          assert.equal(save.status, 200)
        } else {
          read++
          assert.equal(data.input.slideId, slideId)
        }
        await fetch(`${address}/api/runs/${runId}/commands/${data.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, data: { revision: data.name === 'read_context' ? 0 : 1 } }) })
      }
      if (done) break
    }
    assert.equal(applied, 1, 'The pre-read mutation must never reach the browser')
    assert.equal(read, 1)
    assert.equal(store.get(deck.id).revision, 1)
    assert.equal(comments.get(deck.id, thread.id).resolved, false)
    assert.equal(comments.get(deck.id, thread.id).messages.length, 1)
    assert.doesNotMatch(JSON.stringify(store.messages(deck.id)[2]!.content), /PRIVATE_COMMENT_ONLY/, 'Only explicitly supplied display text is put into normal chat history')
  } finally { await app.close(); store.close() }
})
