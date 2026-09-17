import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneGraph } from '@open-pencil/scene-graph'
import { blankPage, capturePage, restorePage, applyPageOperations, pageSizing } from '../src/page-document.js'
import { pageHtml } from '../src/page-html.js'
import { pageSnapshotSchema, pageBatchSchema } from '../shared/page.js'
import { Store } from '../server/store.js'
import { WorkspaceStore } from '../server/workspace-store.js'
import { createApp } from '../server/app.js'

test('page artifacts use real OpenPencil frames, nested layout, stable IDs and round-trip restoration', () => {
  const initial = blankPage('A designed page'), graph = new SceneGraph()
  restorePage(graph, initial)
  const meta = { title: initial.title, pageId: initial.pageId, frameId: initial.frameId }
  applyPageOperations(graph, meta, [
    { op: 'create_page_element', id: 'section', parentId: meta.frameId, type: 'FRAME', props: { layoutMode: 'HORIZONTAL', layoutWrap: 'WRAP', layoutSizingVertical: 'HUG' } },
    { op: 'create_page_element', id: 'text', parentId: 'section', type: 'TEXT', props: { text: 'Readable content', fontSize: 30 } },
  ])
  const snapshot = capturePage(graph, meta)
  assert.equal(graph.getNode('text')!.type, 'TEXT')
  assert.equal(pageSizing(graph.getNode('text')!, graph.getNode('section'), 'HORIZONTAL'), 'FILL')
  assert.equal(graph.getNode('section')!.layoutWrap, 'WRAP')
  const restored = new SceneGraph()
  restorePage(restored, snapshot)
  assert.deepEqual(capturePage(restored, meta), snapshot)
  assert.equal(restored.getNode(meta.frameId)!.width, 1200)
})
test('page validation rejects broken topology, cyclic moves, invalid dimensions and unsafe operations', () => {
  const initial = blankPage(), graph = new SceneGraph()
  restorePage(graph, initial)
  const meta = { title: initial.title, pageId: initial.pageId, frameId: initial.frameId }
  const broken = structuredClone(initial)
  broken.nodes[0]!.childIds.push('missing')
  assert.equal(pageSnapshotSchema.safeParse(broken).success, false)
  assert.equal(pageBatchSchema.safeParse({ expectedRevision: 0, operations: [{ op: 'eval', code: 'alert(1)' }] }).success, false)
  assert.throws(() => applyPageOperations(graph, meta, [{ op: 'delete_page_element', id: meta.frameId }]), /Cannot delete/)
  applyPageOperations(graph, meta, [{ op: 'create_page_element', id: 'frame', parentId: meta.frameId, type: 'FRAME', props: {} }])
  assert.throws(() => applyPageOperations(graph, meta, [{ op: 'move_page_element', id: 'frame', parentId: 'frame', index: 0 }]), /itself/)
  const width = structuredClone(initial)
  width.nodes[0]!.width = 2000
  assert.equal(pageSnapshotSchema.safeParse(width).success, false)
})
test('empty hug-sized sections can be saved before their children arrive in a later batch', () => {
  const initial = blankPage(), graph = new SceneGraph()
  restorePage(graph, initial)
  const meta = { title: initial.title, pageId: initial.pageId, frameId: initial.frameId }
  applyPageOperations(graph, meta, [{
    op: 'create_page_element', id: 'empty-section', parentId: meta.frameId, type: 'FRAME',
    props: { layoutMode: 'VERTICAL', layoutSizingVertical: 'HUG', paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 },
  }])
  assert.equal(graph.getNode('empty-section')!.height, 0)
  const empty = capturePage(graph, meta), restored = new SceneGraph()
  restorePage(restored, empty)
  assert.match(pageHtml(empty), /empty-section/)
  applyPageOperations(restored, meta, [{ op: 'create_page_element', id: 'later-text', parentId: 'empty-section', type: 'TEXT', props: { text: 'Added in the next saved batch' } }])
  assert(restored.getNode('empty-section')!.height > 0)
  const invalid = structuredClone(empty)
  invalid.nodes.find(n => n.id === 'empty-section')!.primaryAxisSizing = 'FIXED'
  assert.equal(pageSnapshotSchema.safeParse(invalid).success, false)
  const leaf = structuredClone(empty)
  leaf.nodes.find(n => n.type === 'TEXT')!.height = 0
  assert.equal(pageSnapshotSchema.safeParse(leaf).success, false)
})
test('page HTML is readable markup, uses auto-layout flow, escapes text and omits hidden content', () => {
  const initial = blankPage('Safe <page>'), graph = new SceneGraph()
  restorePage(graph, initial)
  const meta = { title: initial.title, pageId: initial.pageId, frameId: initial.frameId }
  const title = graph.getChildren(meta.frameId).find(n => n.type === 'TEXT')!
  applyPageOperations(graph, meta, [{ op: 'update_page_element', id: title.id, props: { text: '<script>alert("no")</script> & readable', fontWeight: 700 } }])
  const body = graph.getChildren(meta.frameId)[1]!
  graph.updateNode(body.id, { visible: false, text: 'HIDDEN_PRIVATE_TEXT' })
  const html = pageHtml(capturePage(graph, meta))
  assert.match(html, /<h1 /)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script|HIDDEN_PRIVATE_TEXT|<canvas/)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /display:flex;flex-direction:column/)
  assert.match(html, /Safe &lt;page&gt;/)
})
test('page frames support the rounded corners and outlines advertised by their tool schema', () => {
  const initial = blankPage(), graph = new SceneGraph()
  restorePage(graph, initial)
  const meta = { title: initial.title, pageId: initial.pageId, frameId: initial.frameId }
  applyPageOperations(graph, meta, [{
    op: 'create_page_element', id: 'rounded-card', parentId: meta.frameId, type: 'FRAME',
    props: { cornerRadius: 16, stroke: '#123456', strokeWidth: 2 },
  }])
  const node = graph.getNode('rounded-card')!
  assert.equal(node.type, 'FRAME')
  assert.equal(node.cornerRadius, 16)
  assert.equal(node.strokes[0]!.weight, 2)
  const html = pageHtml(capturePage(graph, meta))
  assert.match(html, /border-radius:16px/)
  assert.match(html, /outline:2px solid/)
})
test('page storage preserves revisions, idempotent receipts, ownership and restart durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pencil-pages-')), path = join(dir, 'pages.sqlite')
  let store = new Store(path)
  try {
    let ws = new WorkspaceStore(store)
    const conversation = ws.createConversation(), id = randomUUID()
    const artifact = ws.createArtifact(conversation.id, 'page', 'Page', id)
    assert.deepEqual(ws.createArtifact(conversation.id, 'page', 'Page', id), artifact)
    const snapshot = { ...ws.page(artifact.id).snapshot, title: 'Saved page' }
    const input = { expectedRevision: 0, commandId: randomUUID(), snapshot }
    assert.deepEqual(ws.savePage(conversation.id, artifact.id, input), { revision: 1 })
    assert.deepEqual(ws.savePage(conversation.id, artifact.id, input), { revision: 1 })
    assert.throws(() => ws.savePage(conversation.id, artifact.id, { ...input, commandId: randomUUID() }), /Revision conflict/)
    assert.throws(() => ws.savePage(conversation.id, artifact.id, { ...input, snapshot: { ...snapshot, title: 'Different' } }), /different content/)
    assert.throws(() => ws.open(ws.createConversation().id, artifact.id), /not found/)
    store.close(); store = new Store(path); ws = new WorkspaceStore(store)
    assert.equal(ws.open(conversation.id, artifact.id).kind, 'page')
    assert.equal(ws.page(artifact.id).snapshot.title, 'Saved page')
    assert.equal(ws.page(artifact.id).revision, 1)
  } finally {
    store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
    rmdirSync(dir)
  }
})
test('page API exposes the third kind, validates snapshots, and starts with separate empty comments', async () => {
  const store = new Store(':memory:'), ws = new WorkspaceStore(store), app = createApp(store)
  try {
    const conversation = ws.createConversation()
    const response = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/artifacts`, payload: { kind: 'page', title: 'Test page', commandId: randomUUID() } })
    assert.equal(response.statusCode, 200, response.body)
    const artifact = response.json()
    const base = `/api/conversations/${conversation.id}/artifacts/${artifact.id}`
    assert.equal((await app.inject({ url: base })).json().kind, 'page')
    const comments = await app.inject({ url: base + '/comments' })
    assert.equal(comments.statusCode, 200)
    assert.deepEqual(comments.json(), [])
    assert.equal((await app.inject({ method: 'PUT', url: base, payload: { expectedRevision: 0, commandId: randomUUID(), snapshot: {} } })).statusCode, 400)
  } finally { await app.close(); store.close() }
})
