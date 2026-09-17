import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocumentSaveQueue } from '../src/document-save.js'
import { applyTextBatch, blankDocument, replayTextSteps, type TextSnapshot } from '../shared/rich-text.js'
import { normalizeArtifactCards, upsertArtifactCard, type ArtifactCardData } from '../shared/artifacts.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
type Request = { expectedRevision: number; commandId: string; snapshot: TextSnapshot; steps: unknown[] }
test('autosave freezes a transaction prefix and retains typing and title edits made during the request', async () => {
  const initial = blankDocument('Original')
  const firstAck = deferred<{ revision: number }>()
  const requests: Request[] = []
  const queue = new DocumentSaveQueue(initial, 0, async body => {
    requests.push(JSON.parse(body))
    return requests.length === 1 ? firstAck.promise : { revision: 2 }
  })
  const first = applyTextBatch(initial, [{ op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'First' }] }])
  queue.append(first.steps)
  const pending = queue.save(first.snapshot)
  await Promise.resolve()
  const second = applyTextBatch(first.snapshot, [
    { op: 'replace_range', from: 6, to: 6, content: [{ type: 'text', text: ' and later' }] },
    { op: 'set_title', title: 'New title' },
  ])
  queue.append(second.steps)
  assert.equal(queue.save(second.snapshot), pending)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]!.snapshot, first.snapshot)
  firstAck.resolve({ revision: 1 })
  await pending
  assert.equal(queue.revision, 1)
  assert.equal(queue.saved.title, 'Original')
  assert.deepEqual(queue.steps, second.steps)
  await queue.save(second.snapshot)
  assert.equal(requests[1]!.expectedRevision, 1)
  assert.notEqual(requests[0]!.commandId, requests[1]!.commandId)
  assert.deepEqual(requests[1]!.steps, second.steps)
  const replay = replayTextSteps(first.snapshot, requests[1]!.steps)
  assert.deepEqual(replay.doc.toJSON(), second.snapshot.content)
  assert.equal(replay.title, 'New title')
  assert.equal(queue.revision, 2)
  assert.equal(queue.steps.length, 0)
})
test('failed background saves retain the entire unsaved transaction sequence', async () => {
  const initial = blankDocument()
  const ack = deferred<{ revision: number }>()
  let attempt = 0
  const queue = new DocumentSaveQueue(initial, 0, async () => ++attempt === 1 ? ack.promise : { revision: 1 })
  const first = applyTextBatch(initial, [{ op: 'replace_range', from: 1, to: 1, content: [{ type: 'text', text: 'First' }] }])
  queue.append(first.steps)
  const pending = queue.save(first.snapshot)
  const second = applyTextBatch(first.snapshot, [{ op: 'replace_range', from: 6, to: 6, content: [{ type: 'text', text: ' tail' }] }])
  queue.append(second.steps)
  const failure = assert.rejects(pending, /Unavailable/)
  ack.reject(new Error('Unavailable'))
  await failure
  assert.equal(queue.revision, 0)
  assert.deepEqual(queue.steps, [...first.steps, ...second.steps])
  await queue.save(second.snapshot)
  assert.deepEqual(queue.saved, second.snapshot)
  assert.equal(queue.steps.length, 0)
})
test('artifact updates keep the first card identity and position, with the newest revision', () => {
  const cards: ArtifactCardData[] = []
  const initial: ArtifactCardData = { id: 'doc', kind: 'document', title: 'Draft', revision: 0 }
  upsertArtifactCard(cards, initial)
  const first = cards[0]
  upsertArtifactCard(cards, { id: 'slides', kind: 'slides', title: 'Deck', revision: 0 })
  upsertArtifactCard(cards, { ...initial, title: 'Finished', revision: 3 })
  upsertArtifactCard(cards, initial)
  assert.equal(cards.length, 2)
  assert.equal(cards[0], first)
  assert.equal(cards[0]!.title, 'Finished')
  assert.equal(cards[0]!.revision, 3)
  const message = normalizeArtifactCards({ role: 'assistant', content: 'Done', artifacts: [initial, cards[1]!, cards[0]!, initial] })
  assert.deepEqual(message.artifacts, cards)
})
