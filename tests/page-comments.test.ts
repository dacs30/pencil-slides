import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneGraph } from '@open-pencil/scene-graph'
import { Store } from '../server/store.js'
import { WorkspaceStore } from '../server/workspace-store.js'
import { CommentStore } from '../server/comments.js'
import { createApp } from '../server/app.js'
import { restorePage, capturePage, applyPageOperations } from '../src/page-document.js'
import { objectPointOnSlide, resolveCommentAnchor } from '../src/comment-geometry.js'
import { pageHtml } from '../src/page-html.js'
import { createPageCommentSchema } from '../shared/comments.js'

function fixture(path = ':memory:') {
  const store = new Store(path), ws = new WorkspaceStore(store), comments = new CommentStore(store, true)
  const conversation = ws.createConversation(), artifact = ws.createArtifact(conversation.id, 'page', 'Review page', randomUUID())
  const snapshot = ws.page(artifact.id).snapshot, graph = new SceneGraph()
  restorePage(graph, snapshot)
  const meta = { title: snapshot.title, pageId: snapshot.pageId, frameId: snapshot.frameId }
  applyPageOperations(graph, meta, [
    { op: 'create_page_element', id: 'section', parentId: meta.frameId, type: 'FRAME', props: { layoutMode: 'NONE', height: 3000, layoutSizingVertical: 'FIXED', rotation: 10 } },
    { op: 'create_page_element', id: 'nested-text', parentId: 'section', type: 'TEXT', props: { text: 'Review this nested text', x: 40, y: 1400, width: 500, height: 100, layoutSizingHorizontal: 'FIXED', textAutoResize: 'NONE' } },
  ])
  ws.savePage(conversation.id, artifact.id, { snapshot: capturePage(graph, meta), expectedRevision: 0, commandId: randomUUID() })
  return { store, ws, comments, conversation, artifact, graph, meta }
}
test('page point comments use actual tall-artboard bounds and never change artwork revisions', () => {
  const f = fixture()
  try {
    const input = { id: randomUUID(), expectedRevision: 1, anchor: { kind: 'point' as const, slideId: f.meta.frameId, x: 300, y: 2000 }, body: 'A note far below slide height' }
    assert.equal(createPageCommentSchema.safeParse(input).success, true)
    const thread = f.comments.create(f.artifact.id, input)
    assert.equal(thread.anchor.y, 2000)
    assert.deepEqual(f.comments.create(f.artifact.id, input), thread)
    assert.equal(f.ws.page(f.artifact.id).revision, 1)
    assert.throws(() => f.comments.create(f.artifact.id, { ...input, id: randomUUID(), anchor: { ...input.anchor, y: 19000 } }), /inside the page/)
    assert.throws(() => f.comments.create(f.artifact.id, { ...input, id: randomUUID(), anchor: { ...input.anchor, x: 1500 } }), /inside the page/)
    assert.throws(() => f.comments.create(f.artifact.id, { ...input, body: 'Changed payload' }), /different content/)
    assert.doesNotMatch(pageHtml(f.ws.page(f.artifact.id).snapshot), /A note far below slide height/)
  } finally { f.store.close() }
})
test('page object comments use nested world transforms, follow in-page moves and detach permanently on deletion', () => {
  const f = fixture()
  try {
    const expected = objectPointOnSlide(f.graph, 'nested-text', f.meta.frameId)!
    let thread = f.comments.create(f.artifact.id, { id: randomUUID(), expectedRevision: 1, anchor: { kind: 'object', slideId: f.meta.frameId, nodeId: 'nested-text' }, body: 'Nested anchor' })
    assert.equal(thread.anchor.x, expected.x)
    assert.equal(thread.anchor.y, expected.y)
    const fallback = { ...thread.anchor }
    applyPageOperations(f.graph, f.meta, [{ op: 'move_page_element', id: 'nested-text', parentId: f.meta.frameId, index: 1 }])
    f.ws.savePage(f.conversation.id, f.artifact.id, { snapshot: capturePage(f.graph, f.meta), expectedRevision: 1, commandId: randomUUID() })
    thread = f.comments.get(f.artifact.id, thread.id)
    assert.equal(thread.detached, null)
    assert.deepEqual(thread.anchor, fallback)
    assert.notDeepEqual(resolveCommentAnchor(f.graph, thread).point, expected)
    const before = capturePage(f.graph, f.meta)
    applyPageOperations(f.graph, f.meta, [{ op: 'delete_page_element', id: 'nested-text' }])
    f.ws.savePage(f.conversation.id, f.artifact.id, { snapshot: capturePage(f.graph, f.meta), expectedRevision: 2, commandId: randomUUID() })
    assert.equal(f.comments.get(f.artifact.id, thread.id).detached, 'object_deleted')
    f.ws.savePage(f.conversation.id, f.artifact.id, { snapshot: before, expectedRevision: 3, commandId: randomUUID() })
    assert.equal(f.comments.get(f.artifact.id, thread.id).detached, 'object_deleted')
    assert.deepEqual(f.comments.get(f.artifact.id, thread.id).anchor, fallback)
  } finally { f.store.close() }
})
test('page section comments, replies and resolve/reopen survive database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pencil-page-comments-')), path = join(dir, 'test.sqlite')
  const f = fixture(path)
  let reopened: Store | undefined
  try {
    let thread = f.comments.create(f.artifact.id, { id: randomUUID(), expectedRevision: 1, anchor: { kind: 'object', slideId: f.meta.frameId, nodeId: 'section' }, body: 'Section review' })
    const reply = { id: randomUUID(), expectedVersion: thread.version, body: 'A reply' }
    thread = f.comments.reply(f.artifact.id, thread.id, reply)
    assert.equal(f.comments.reply(f.artifact.id, thread.id, reply).messages.length, 2)
    thread = f.comments.resolve(f.artifact.id, thread.id, { expectedVersion: thread.version, resolved: true })
    assert.throws(() => f.comments.handoff(f.artifact.id, thread.id, thread.version), /Reopen/)
    thread = f.comments.resolve(f.artifact.id, thread.id, { expectedVersion: thread.version, resolved: false })
    assert.match(f.comments.handoff(f.artifact.id, thread.id, thread.version).content, /view "page"/)
    assert.throws(() => f.comments.handoff(f.artifact.id, thread.id, thread.version - 1), /Thread changed/)
    f.store.close(); reopened = new Store(path)
    assert.deepEqual(new CommentStore(reopened, true).get(f.artifact.id, thread.id), thread)
    assert.equal(new WorkspaceStore(reopened).page(f.artifact.id).revision, 1)
  } finally {
    if (reopened) reopened.close(); else f.store.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
    rmdirSync(dir)
  }
})
test('page comment API enforces conversation ownership and rejects foreign anchors', async () => {
  const f = fixture(), app = createApp(f.store)
  try {
    const base = `/api/conversations/${f.conversation.id}/artifacts/${f.artifact.id}/comments`
    const input = { id: randomUUID(), expectedRevision: 1, anchor: { kind: 'object', slideId: f.meta.frameId, nodeId: 'nested-text' }, body: 'API review' }
    const created = await app.inject({ method: 'POST', url: base, payload: input })
    assert.equal(created.statusCode, 200, created.body)
    const other = f.ws.createConversation()
    assert.equal((await app.inject({ url: `/api/conversations/${other.id}/artifacts/${f.artifact.id}/comments` })).statusCode, 404)
    assert.equal((await app.inject({ method: 'POST', url: base, payload: { ...input, id: randomUUID(), anchor: { ...input.anchor, nodeId: 'missing' } } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'POST', url: base, payload: { ...input, id: randomUUID(), anchor: { ...input.anchor, nodeId: f.meta.frameId } } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'PATCH', url: `${base}/${created.json().id}`, payload: { expectedVersion: 1, resolved: true } })).statusCode, 200)
  } finally { await app.close(); f.store.close() }
})
