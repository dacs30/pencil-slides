import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { Store } from '../server/store.js'
import { WorkspaceStore } from '../server/workspace-store.js'
import { createApp } from '../server/app.js'
import { blankDeck } from '../src/document.js'
import { blankDocument, richContentSchema, textSnapshotSchema, applyTextBatch, replayTextSteps, mapTextAnchor, richSchema } from '../shared/rich-text.js'
import { exportWord } from '../src/word-export.js'
import { artifactBatchSchema } from '../shared/artifacts.js'
import { z } from 'zod'
import { EditorState } from '@tiptap/pm/state'
import { Step } from '@tiptap/pm/transform'
import { history, undo, redo } from '@tiptap/pm/history'

const content = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'A short story' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'One idea becomes a document and a deck.' }] },
] }
function fixture() {
  const store = new Store(':memory:'), ws = new WorkspaceStore(store), conversation = ws.createConversation()
  const artifact = ws.createArtifact(conversation.id, 'document', 'Draft', randomUUID())
  return { store, ws, conversation, artifact }
}
test('document contracts reject unsupported structures, unsafe links and oversized content', () => {
  assert.equal(richContentSchema.parse(content).type, 'doc')
  for (const bad of [
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.com' } }] },
    { type: 'doc', content: [{ type: 'text', text: 'not a block' }] },
    { type: 'doc', content: [{ type: 'heading', attrs: { level: 9 } }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(100001) }] }] },
  ]) assert.equal(richContentSchema.safeParse(bad).success, false)
  assert.doesNotThrow(() => z.toJSONSchema(artifactBatchSchema, { io: 'input' }))
})
test('text batches are atomic, preserve marks and map ranges through inserts and deletions', () => {
  const initial = textSnapshotSchema.parse({ ...blankDocument(), content })
  const doc = richSchema.nodeFromJSON(initial.content)
  const anchor = { from: 3, to: 8, quote: doc.textBetween(3, 8), detached: false }
  const update = applyTextBatch(initial, [{ op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'New ', marks: [{ type: 'bold' }] }] }])
  const replay = replayTextSteps(initial, update.steps)
  assert.deepEqual(mapTextAnchor(anchor, replay.maps), { ...anchor, from: 7, to: 12 })
  assert.equal(replay.doc.firstChild!.firstChild!.marks[0]!.type.name, 'bold')
  const deletion = applyTextBatch(update.snapshot, [{ op: 'replace_range', from: 7, to: 12, content: [] }])
  const detached = mapTextAnchor({ ...anchor, from: 7, to: 12 }, replayTextSteps(update.snapshot, deletion.steps).maps)
  assert.equal(detached.detached, true)
  assert.equal(mapTextAnchor(detached, replay.maps).detached, true)
  const replace = applyTextBatch(initial, [{ op: 'replace_range', from: anchor.from, to: anchor.to, content: [{ type: 'text', text: 'A replacement' }] }])
  assert.equal(mapTextAnchor(anchor, replayTextSteps(initial, replace.steps).maps).detached, true)
  assert.throws(() => applyTextBatch(initial, [
    { op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'Must roll back' }] },
    { op: 'replace_range', from: 99999, to: 99999, content: [] },
  ]), /outside/)
  assert.deepEqual(initial.content, textSnapshotSchema.parse({ ...blankDocument(), content }).content)
})
test('conversations hold both kinds; saves check step replay, revision and idempotency', () => {
  const { store, ws, conversation, artifact } = fixture()
  try {
    const command = randomUUID()
    const slide = ws.createArtifact(conversation.id, 'slides', 'Deck', command)
    assert.deepEqual(ws.createArtifact(conversation.id, 'slides', 'Deck', command), slide)
    assert.equal(ws.conversation(conversation.id).artifacts.length, 2)
    const other = ws.createConversation()
    assert.throws(() => ws.open(other.id, artifact.id), /not found/)
    const update = applyTextBatch(ws.document(artifact.id).snapshot, [{ op: 'replace_document', content }])
    const input = { ...update, commandId: randomUUID(), expectedRevision: 0 }
    assert.deepEqual(ws.saveDocument(conversation.id, artifact.id, input), { revision: 1 })
    assert.deepEqual(ws.saveDocument(conversation.id, artifact.id, input), { revision: 1 })
    assert.throws(() => ws.saveDocument(conversation.id, artifact.id, { ...input, commandId: randomUUID() }), /Revision conflict/)
    assert.throws(() => ws.saveDocument(conversation.id, artifact.id, { ...input, expectedRevision: 1 }), /different content/)
    assert.throws(() => ws.saveDocument(conversation.id, artifact.id, {
      ...input, commandId: randomUUID(), expectedRevision: 1, steps: [], snapshot: blankDocument(),
    }), /does not match/)
    assert.equal(ws.document(artifact.id).revision, 1)
  } finally { store.close() }
})
test('a document AI batch undoes and redoes content and title together with replayable steps', () => {
  const before = textSnapshotSchema.parse({ ...blankDocument('Before'), content })
  const batch = applyTextBatch(before, [
    { op: 'set_title', title: 'After' },
    { op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'New ' }] },
  ])
  let state = EditorState.create({ schema: richSchema, doc: richSchema.nodeFromJSON(before.content), plugins: [history()] })
  let tr = state.tr
  for (const raw of batch.steps) tr = tr.step(Step.fromJSON(richSchema, raw))
  state = state.apply(tr)
  let current = batch.snapshot
  assert(undo(state, transaction => {
    const replay = replayTextSteps(current, transaction.steps.map(s => s.toJSON()))
    current = { version: 1, title: replay.title, content: replay.doc.toJSON() }
    state = state.apply(transaction)
  }))
  assert.deepEqual(current, before)
  assert(redo(state, transaction => {
    const replay = replayTextSteps(current, transaction.steps.map(s => s.toJSON()))
    current = { version: 1, title: replay.title, content: replay.doc.toJSON() }
    state = state.apply(transaction)
  }))
  assert.deepEqual(current, batch.snapshot)
})
test('document comments track duplicate-text ranges durably, detach permanently, and never change content revisions', () => {
  const { store, ws, conversation, artifact } = fixture()
  try {
    const update = applyTextBatch(ws.document(artifact.id).snapshot, [{ op: 'replace_document', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'same same same' }] }] } }])
    ws.saveDocument(conversation.id, artifact.id, { ...update, commandId: randomUUID(), expectedRevision: 0 })
    const create = { id: randomUUID(), from: 6, to: 10, body: 'Middle word', expectedRevision: 1 }
    const thread = ws.comment(artifact.id, create)
    assert.deepEqual(ws.comment(artifact.id, create), thread)
    assert.equal(ws.document(artifact.id).revision, 1)
    const insert = applyTextBatch(update.snapshot, [{ op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'same ' }] }])
    ws.saveDocument(conversation.id, artifact.id, { ...insert, commandId: randomUUID(), expectedRevision: 1 })
    assert.equal(ws.thread(artifact.id, thread.id).anchor.from, 11)
    const remove = applyTextBatch(insert.snapshot, [{ op: 'replace_range', from: 11, to: 15, content: [] }])
    ws.saveDocument(conversation.id, artifact.id, { ...remove, commandId: randomUUID(), expectedRevision: 2 })
    assert.equal(ws.thread(artifact.id, thread.id).anchor.detached, true)
    const restore = applyTextBatch(remove.snapshot, [{ op: 'replace_range', from: 11, to: 11, content: [{ type: 'text', text: 'same' }] }])
    ws.saveDocument(conversation.id, artifact.id, { ...restore, commandId: randomUUID(), expectedRevision: 3 })
    let current = ws.thread(artifact.id, thread.id)
    assert.equal(current.anchor.detached, true)
    const reply = { id: randomUUID(), expectedVersion: current.version, body: 'A reply' }
    current = ws.updateThread(artifact.id, thread.id, reply, true)
    assert.equal(ws.updateThread(artifact.id, thread.id, reply, true).messages.length, 2)
    current = ws.updateThread(artifact.id, thread.id, { expectedVersion: current.version, resolved: true }, false)
    assert.equal(current.resolved, true)
    assert.throws(() => ws.updateThread(artifact.id, thread.id, { ...reply, id: randomUUID(), expectedVersion: current.version }, true), /resolved/)
  } finally { store.close() }
})
test('legacy decks and chat migrate once without destroying snapshots or comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pencil-migration-')), path = join(dir, 'test.sqlite')
  let store = new Store(path)
  try {
    const deck = store.create(blankDeck())
    store.append(deck.id, 'user', 'Original request')
    store.append(deck.id, 'assistant', 'Original artifact', { artifacts: [{ title: 'Deck', revision: 0, slideIds: deck.snapshot.slides.map(s => s.id) }] })
    store.close(); store = new Store(path)
    let ws = new WorkspaceStore(store)
    assert.equal(ws.conversation(deck.id).artifacts[0]!.kind, 'slides')
    assert.equal(ws.messages(deck.id)[1]!.artifacts![0]!.id, deck.id)
    assert.deepEqual(ws.open(deck.id, deck.id).value.snapshot, deck.snapshot)
    store.close(); store = new Store(path); ws = new WorkspaceStore(store)
    assert.equal(ws.messages(deck.id).length, 2)
    assert.equal(ws.conversations().length, 1)
  } finally { store.close(); rmSync(path, { force: true }); rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true }); rmdirSync(dir) }
})
test('Word export produces semantic headings, editable formatting, lists, safe links and explicit page size', async () => {
  const bytes = await exportWord({
    version: 1, title: 'Word example', content: { type: 'doc', content: [
      ...content.content,
      { type: 'paragraph', content: [{ type: 'text', text: 'Styled', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'highlight' }] }, { type: 'hardBreak' }, { type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Numbered item' }] }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bullet item' }] }] }] },
    ] },
  })
  const files = unzipSync(bytes), xml = strFromU8(files['word/document.xml']!)
  assert.match(xml, /Heading1/)
  for (const text of ['A short story', 'Styled', 'Numbered item', 'Bullet item']) assert.match(xml, new RegExp(text))
  assert.match(xml, /w:b[ />]/); assert.match(xml, /w:i[ />]/); assert.match(xml, /w:u /); assert.match(xml, /w:highlight/)
  assert.match(xml, /w:w="12240"/); assert.match(xml, /w:h="15840"/)
  assert.match(strFromU8(files['word/numbering.xml']!), /w:start w:val="3"/)
  assert.match(strFromU8(files['word/_rels/document.xml.rels']!), /https:\/\/example.com/)
  assert.doesNotMatch(xml, /commentRange|commentReference/)
  if (files['word/comments.xml']) assert.doesNotMatch(strFromU8(files['word/comments.xml']), /<w:comment /)
})
test('workspace API validates artifact ownership, document saves and comment routes', async () => {
  const { store, ws, conversation, artifact } = fixture()
  const app = createApp(store)
  try {
    const base = `/api/conversations/${conversation.id}/artifacts/${artifact.id}`
    assert.equal((await app.inject({ url: base })).statusCode, 200)
    assert.equal((await app.inject({ method: 'PUT', url: base, payload: {} })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: base, payload: { commandId: randomUUID(), expectedRevision: 0, snapshot: ws.document(artifact.id).snapshot, steps: [{ stepType: 'unknown' }] } })).statusCode, 400)
    const another = ws.createConversation()
    assert.equal((await app.inject({ url: `/api/conversations/${another.id}/artifacts/${artifact.id}` })).statusCode, 404)
    assert.equal((await app.inject({ method: 'POST', url: base + '/comments', payload: { id: randomUUID(), from: 1, to: 2, expectedRevision: 0, body: 'Invalid empty range' } })).statusCode, 400)
  } finally { await app.close(); store.close() }
})
