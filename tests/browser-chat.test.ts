import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageWriter } from '../src/browser-chat.js'
import { restoreWorkspaceMessage, type WorkspaceMessage } from '../shared/artifacts.js'

test('reloaded in-progress responses are marked inactive without rewriting stored state', () => {
  const stored: WorkspaceMessage = { role: 'assistant', content: '', runState: 'running', activities: [{ id: 'tool', name: 'apply_batch', status: 'running' }] }
  const restored = restoreWorkspaceMessage(stored)
  assert.equal(restored.runState, 'interrupted')
  assert.equal(restored.activities![0]!.status, 'interrupted')
  assert.match(restored.content, /not active in this tab/)
  assert.equal(stored.runState, 'running')
  assert.equal(stored.activities![0]!.status, 'running')
})
test('streamed transcript checkpoints are serialized and preserve their captured contents', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let current: WorkspaceMessage = { role: 'assistant', content: 'First', runState: 'running' }
  const saved: WorkspaceMessage[] = [], errors: unknown[] = []
  const writer = new MessageWriter('conversation', 'message', () => current, error => errors.push(error), {
    putMessage: async (_conversation, id, value) => {
      saved.push(value as WorkspaceMessage)
      if (saved.length === 1) await gate
      return { id }
    },
  })
  writer.changed(); const first = writer.flush()
  await Promise.resolve()
  current = { role: 'assistant', content: 'Second', runState: 'complete' }
  writer.changed(); const second = writer.flush()
  assert.equal(saved.length, 1)
  release(); await Promise.all([first, second])
  assert.deepEqual(saved.map(m => m.content), ['First', 'Second'])
  assert.deepEqual(errors, [])
})
test('transcript storage failures are surfaced once and stop subsequent checkpoints', async () => {
  const errors: unknown[] = []
  let writes = 0
  const writer = new MessageWriter('conversation', 'message', () => ({ role: 'assistant', content: 'Text' }), error => errors.push(error), {
    putMessage: async () => { writes++; throw new Error('Storage unavailable') },
  })
  writer.changed(); await assert.rejects(writer.flush(), /Storage unavailable/)
  writer.changed(); await assert.rejects(writer.flush(), /Storage unavailable/)
  assert.equal(writes, 1)
  assert.equal(errors.length, 1)
})
