import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deleteDB } from 'idb'
import { BrowserStore } from '../src/local-store.js'
import { applyTextBatch, richSchema } from '../shared/rich-text.js'
import { SceneGraph } from '@open-pencil/scene-graph'
import { restorePage, capturePage, applyPageOperations } from '../src/page-document.js'

test('IndexedDB persists all artifact kinds and chat across store reopen, without sharing separate browser stores', async () => {
  const name = `pencil-test-${randomUUID()}`, otherName = `pencil-test-${randomUUID()}`
  let store = new BrowserStore(name)
  const other = new BrowserStore(otherName)
  try {
    const conversation = await store.createConversation()
    for (const kind of ['document', 'slides', 'page'] as const) await store.createArtifact(conversation.id, { kind, title: kind }, randomUUID())
    await store.putMessage(conversation.id, randomUUID(), { role: 'user', content: 'My private browser workspace' })
    await store.close(); store = new BrowserStore(name)
    const reopened = await store.conversation(conversation.id)
    assert.deepEqual(reopened.artifacts.map(a => a.kind), ['document', 'slides', 'page'])
    assert.equal((await store.messages(conversation.id))[0]!.content, 'My private browser workspace')
    assert.deepEqual(await other.conversations(), [])
    await assert.rejects(other.conversation(conversation.id), /not found/)
  } finally { await store.close(); await other.close(); await deleteDB(name); await deleteDB(otherName) }
})
test('IndexedDB serializes revisions across tabs and atomically saves document steps with receipts', async () => {
  const name = `pencil-test-${randomUUID()}`, store = new BrowserStore(name), tab = new BrowserStore(name)
  try {
    const conversation = await store.createConversation()
    const command = randomUUID()
    const artifact = await store.createArtifact(conversation.id, { kind: 'document', title: 'Draft' }, command)
    assert.deepEqual(await store.createArtifact(conversation.id, { kind: 'document', title: 'Draft' }, command), artifact)
    const initial = await store.open(conversation.id, artifact.id)
    assert.equal(initial.kind, 'document')
    if (initial.kind !== 'document') throw new Error('Wrong fixture kind')
    const edit = applyTextBatch(initial.value.snapshot, [{ op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'Saved locally' }] }])
    const body = { expectedRevision: 0, commandId: randomUUID(), ...edit }
    const results = await Promise.allSettled([
      store.save(conversation.id, artifact.id, body),
      tab.save(conversation.id, artifact.id, { ...body, commandId: randomUUID() }),
    ])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const current = await store.open(conversation.id, artifact.id)
    assert.equal(current.value.revision, 1)
    if (current.kind !== 'document') throw new Error('Wrong fixture kind')
    assert.equal(richSchema.nodeFromJSON(current.value.snapshot.content).textContent, 'Saved locally')
    const receipt = await store.receipt(conversation.id, artifact.id, body.commandId)
    if (receipt) assert.deepEqual(await store.save(conversation.id, artifact.id, body), { revision: 1 })
    await assert.rejects(store.save(conversation.id, artifact.id, { ...body, snapshot: initial.value.snapshot, commandId: randomUUID(), expectedRevision: 1, steps: [] }), /does not match/)
    assert.equal((await store.open(conversation.id, artifact.id)).value.revision, 1)
  } finally { await store.close(); await tab.close(); await deleteDB(name) }
})
test('browser-local comments preserve order, replies, range mapping and durable detachment', async () => {
  const name = `pencil-test-${randomUUID()}`, store = new BrowserStore(name)
  try {
    const conversation = await store.createConversation()
    const page = await store.createArtifact(conversation.id, { kind: 'page', title: 'Page' }, randomUUID())
    const opened = await store.open(conversation.id, page.id)
    if (opened.kind !== 'page') throw new Error('Wrong fixture kind')
    const target = opened.value.snapshot.nodes.find(n => n.type === 'TEXT')!
    const input = { id: randomUUID(), expectedRevision: 0, anchor: { kind: 'object', slideId: opened.value.snapshot.frameId, nodeId: target.id }, body: 'First note' }
    const first = await store.comment(conversation.id, page.id, input)
    await store.comment(conversation.id, page.id, { ...input, id: randomUUID(), body: 'Second note' })
    assert.deepEqual((await store.comments(conversation.id, page.id)).map(c => c.thread.messages[0]!.body), ['First note', 'Second note'])
    const reply = { id: randomUUID(), expectedVersion: 1, body: 'Reply' }
    await store.updateComment(conversation.id, page.id, first.id, reply, true)
    assert.equal((await store.updateComment(conversation.id, page.id, first.id, reply, true)).messages.length, 2)
    const graph = new SceneGraph()
    restorePage(graph, opened.value.snapshot)
    const meta = { title: opened.value.snapshot.title, pageId: opened.value.snapshot.pageId, frameId: opened.value.snapshot.frameId }
    applyPageOperations(graph, meta, [{ op: 'delete_page_element', id: target.id }])
    await store.save(conversation.id, page.id, { expectedRevision: 0, commandId: randomUUID(), snapshot: capturePage(graph, meta) })
    await store.save(conversation.id, page.id, { expectedRevision: 1, commandId: randomUUID(), snapshot: opened.value.snapshot })
    const comments = await store.comments(conversation.id, page.id)
    assert(comments.every(c => c.kind === 'canvas' && c.thread.detached === 'object_deleted'))
    assert.equal((await store.comment(conversation.id, page.id, input)).id, first.id)
    const doc = await store.createArtifact(conversation.id, { kind: 'document', title: 'Doc' }, randomUUID())
    const document = await store.open(conversation.id, doc.id)
    if (document.kind !== 'document') throw new Error('Wrong fixture kind')
    const text = applyTextBatch(document.value.snapshot, [{ op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'Review this' }] }])
    await store.save(conversation.id, doc.id, { ...text, commandId: randomUUID(), expectedRevision: 0 })
    await store.comment(conversation.id, doc.id, { id: randomUUID(), expectedRevision: 1, from: 1, to: 7, body: 'A text note' })
    const insert = applyTextBatch(text.snapshot, [{ op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'New ' }] }])
    await store.save(conversation.id, doc.id, { ...insert, commandId: randomUUID(), expectedRevision: 1 })
    const comment = (await store.comments(conversation.id, doc.id))[0]!
    assert(comment.kind === 'document')
    assert.equal(comment.thread.anchor.from, 5)
  } finally { await store.close(); await deleteDB(name) }
})
test('workspace backups import atomically as new conversations with remapped cards and comments', async () => {
  const name = `pencil-test-${randomUUID()}`, store = new BrowserStore(name)
  try {
    const conversation = await store.createConversation('Original')
    const artifact = await store.createArtifact(conversation.id, { kind: 'page', title: 'Page' }, randomUUID())
    const opened = await store.open(conversation.id, artifact.id)
    if (opened.kind !== 'page') throw new Error('Wrong fixture kind')
    await store.comment(conversation.id, artifact.id, { id: randomUUID(), expectedRevision: 0, anchor: { kind: 'point', slideId: opened.value.snapshot.frameId, x: 100, y: 100 }, body: 'Keep this note' })
    await store.putMessage(conversation.id, randomUUID(), { role: 'assistant', content: 'Created', artifacts: [artifact] })
    const backup = await store.exportBackup()
    const [id] = await store.importBackup(backup)
    assert(id && id !== conversation.id)
    const imported = await store.conversation(id)
    assert.notEqual(imported.artifacts[0]!.id, artifact.id)
    assert.equal((await store.messages(id))[0]!.artifacts![0]!.id, imported.artifacts[0]!.id)
    const comment = (await store.comments(id, imported.artifacts[0]!.id))[0]!
    assert(comment.kind === 'canvas')
    assert.equal(comment.thread.deckId, imported.artifacts[0]!.id)
    const invalid = structuredClone(backup)
    invalid.conversations[0]!.messages[0]!.artifacts![0]!.id = 'missing'
    await assert.rejects(store.importBackup(invalid), /missing or mismatched/)
    assert.equal((await store.conversations()).length, 2)
    assert.equal((await store.open(conversation.id, artifact.id)).value.snapshot.title, 'Page')
  } finally { await store.close(); await deleteDB(name) }
})
