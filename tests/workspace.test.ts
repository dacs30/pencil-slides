import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { Store } from '../server/store.js'
import { WorkspaceStore } from '../server/workspace-store.js'
import { createApp } from '../server/app.js'
import { workspaceProvider } from './workspace-provider.js'
import { applyTextBatch, richSchema } from '../shared/rich-text.js'
import { artifactBatchSchema, artifactBatchToolSchema, artifactReadSchema, validateArtifactTool, type ArtifactCommand } from '../shared/artifacts.js'
import type { ToolResult } from '../shared/model.js'
import type { Provider } from '../server/agent.js'
import { workspaceTools } from '../server/workspace-api.js'
import { z } from 'zod'
import { CommentStore } from '../server/comments.js'
import { SceneGraph } from '@open-pencil/scene-graph'
import { restorePage, capturePage, applyPageOperations } from '../src/page-document.js'
import { pageBatchSchema } from '../shared/page.js'

test('published Anthropic tools have object roots without root unions and retain both operation kinds', () => {
  assert.deepEqual(workspaceTools.map(tool => tool.name), ['read_context', 'create_artifact', 'apply_batch'])
  for (const tool of workspaceTools) {
    assert.equal(tool.input_schema.type, 'object', tool.name)
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) assert.equal(keyword in tool.input_schema, false, `${tool.name}: ${keyword}`)
  }
  const schema = workspaceTools.find(tool => tool.name === 'apply_batch')!.input_schema
  const generated = z.toJSONSchema(artifactBatchToolSchema, { io: 'input' })
  assert.deepEqual(schema.properties, generated.properties)
  const operations = generated.properties?.operations
  assert(operations && typeof operations === 'object')
  assert.equal(operations.type, 'array')
  assert.equal(operations.minItems, 1)
  assert.equal(operations.maxItems, 100)
  assert(generated.required?.includes('operations'))
  assert.equal(operations.anyOf, undefined)
  assert.equal(operations.oneOf, undefined)
  for (const input of [
    { kind: 'slides', artifactId: 'deck', expectedRevision: 0, operations: [{ op: 'create_slide', id: 'slide', title: 'Title' }] },
    { kind: 'document', artifactId: 'doc', expectedRevision: 0, operations: [{ op: 'replace_document', content: { type: 'doc', content: [{ type: 'paragraph' }] } }] },
    { kind: 'page', artifactId: 'page', expectedRevision: 0, operations: [{ op: 'update_page', title: 'Page title' }] },
  ]) {
    assert.doesNotThrow(() => artifactBatchToolSchema.parse(input))
    assert.doesNotThrow(() => validateArtifactTool('apply_batch', input))
    assert.throws(() => validateArtifactTool('apply_batch', { ...input, kind: input.kind === 'slides' ? 'document' : 'slides' }))
  }
})

async function consume(response: Response, command: (data: ArtifactCommand) => Promise<ToolResult>, ack: (run: string, command: string, result: ToolResult) => Promise<void>) {
  assert.equal(response.status, 200)
  const events: { event: string; data: Record<string, unknown> }[] = []
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let buffer = '', runId = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
      const event = packet.match(/^event: (.+)$/m)?.[1], raw = packet.match(/^data: (.+)$/m)?.[1]
      if (!event || !raw) continue
      const data = JSON.parse(raw)
      events.push({ event, data })
      if (event === 'run') runId = data.id
      if (event === 'command') await ack(runId, data.id, await command(data))
    }
    if (done) break
  }
  return events
}
const tool = (name: string, input: unknown): Anthropic.ToolUseBlock => ({ type: 'tool_use', id: randomUUID(), caller: { type: 'direct' }, name, input })
test('shared streamed tools create both artifact kinds and require durable document acknowledgement', async () => {
  const store = new Store(':memory:'), ws = new WorkspaceStore(store), conversation = ws.createConversation()
  const app = createApp(store, workspaceProvider)
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const events = await consume(await fetch(`${url}/api/conversations/${conversation.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Create both a document and slides' }),
    }), async command => {
      if (command.name === 'read_context') {
        const input = artifactReadSchema.parse(command.input), opened = ws.open(conversation.id, input.artifactId!)
        if (opened.kind === 'page') throw new Error('Unexpected page in document/slide fixture')
        return opened.kind === 'document'
          ? { ok: true, data: { kind: 'document', revision: opened.value.revision, content: opened.value.snapshot.content, selection: { from: 1, to: 1 } } }
          : { ok: true, data: { revision: opened.value.revision, slides: opened.value.snapshot.slides } }
      }
      const input = artifactBatchSchema.parse(command.input)
      let payload: unknown
      if (input.kind === 'document') {
        const current = ws.document(input.artifactId)
        payload = { ...applyTextBatch(current.snapshot, input.operations), commandId: command.id, expectedRevision: current.revision }
      } else {
        const current = store.get(input.artifactId), snapshot = structuredClone(current.snapshot)
        snapshot.slides[0]!.title = 'The companion slide deck'
        payload = { snapshot, commandId: command.id, expectedRevision: current.revision }
      }
      const saved = await app.inject({ method: 'PUT', url: `/api/conversations/${conversation.id}/artifacts/${input.artifactId}`, payload: payload as object })
      assert.equal(saved.statusCode, 200, saved.body)
      return { ok: true, data: saved.json() }
    }, async (run, command, result) => {
      const response = await app.inject({ method: 'POST', url: `/api/workspace-runs/${run}/commands/${command}`, payload: result })
      assert.equal(response.statusCode, 200)
    })
    assert(events.some(e => e.event === 'done'))
    assert.equal(events.some(e => e.event === 'error'), false)
    assert.deepEqual(ws.conversation(conversation.id).artifacts.map(a => a.kind), ['document', 'slides'])
    assert(ws.conversation(conversation.id).artifacts.every(a => a.revision === 1))
    assert.equal(ws.messages(conversation.id).at(-1)!.artifacts!.length, 2)
    assert(ws.messages(conversation.id).at(-1)!.artifacts!.every(artifact => artifact.revision === 1))
  } finally { await app.close(); store.close() }
})
test('comment handoff enforces a current read, locks legacy writes and cannot acknowledge unsaved edits', async () => {
  const store = new Store(':memory:'), ws = new WorkspaceStore(store), conversation = ws.createConversation()
  const artifact = ws.createArtifact(conversation.id, 'document', 'A document', randomUUID())
  const initial = applyTextBatch(ws.document(artifact.id).snapshot, [{ op: 'replace_document', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Review this text' }] }] } }])
  ws.saveDocument(conversation.id, artifact.id, { ...initial, expectedRevision: 0, commandId: randomUUID() })
  const thread = ws.comment(artifact.id, { id: randomUUID(), expectedRevision: 1, from: 1, to: 7, body: 'Please shorten this.' })
  let round = 0
  const batch = { kind: 'document', artifactId: artifact.id, expectedRevision: 1, operations: [{ op: 'replace_range', from: 1, to: 7, content: [{ type: 'text', text: 'Read' }] }] }
  const provider: Provider = async (messages, _signal, emit) => {
    if (round === 0) {
      assert.match(JSON.stringify(messages), /untrusted|Untrusted/)
      assert.match(JSON.stringify(messages), /Please shorten/)
    }
    if (round === 1) assert.match(JSON.stringify(messages.at(-1)), /Read current artifact/)
    if (round === 3) assert.match(JSON.stringify(messages.at(-1)), /without a durable save/)
    switch (round++) {
      case 0: return [tool('apply_batch', batch)]
      case 1: return [tool('read_context', { artifactId: artifact.id, view: 'document' })]
      case 2: return [tool('apply_batch', batch)]
      default: emit('The browser did not save the change.'); return [{ type: 'text', text: 'The browser did not save the change.', citations: null }]
    }
  }
  const app = createApp(store, provider), url = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const events = await consume(await fetch(`${url}/api/conversations/${conversation.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Address this comment', artifactId: artifact.id, commentThreadId: thread.id, expectedCommentVersion: thread.version }),
    }), async command => {
      const manual = await app.inject({ method: 'PUT', url: `/api/conversations/${conversation.id}/artifacts/${artifact.id}`, payload: { commandId: randomUUID(), expectedRevision: 1, snapshot: ws.document(artifact.id).snapshot, steps: [] } })
      assert.equal(manual.statusCode, 409)
      return command.name === 'read_context' ? { ok: true, data: { revision: 1, content: ws.document(artifact.id).snapshot.content } } : { ok: true, data: { revision: 2 } }
    }, async (run, command, result) => {
      assert.equal((await app.inject({ method: 'POST', url: `/api/workspace-runs/${run}/commands/${command}`, payload: result })).statusCode, 200)
    })
    assert(events.some(e => e.event === 'tool_result' && !e.data.ok && /durable/.test(String(e.data.error))))
    assert.equal(ws.document(artifact.id).revision, 1)
    assert.equal(ws.thread(artifact.id, thread.id).resolved, false)
    assert.equal(richSchema.nodeFromJSON(ws.document(artifact.id).snapshot.content).textContent, 'Review this text')
  } finally { await app.close(); store.close() }
})
test('page comment handoff requires a full current page read and never auto-resolves the thread', async () => {
  const store = new Store(':memory:'), ws = new WorkspaceStore(store), comments = new CommentStore(store, true)
  const conversation = ws.createConversation(), artifact = ws.createArtifact(conversation.id, 'page', 'Page review', randomUUID())
  const original = ws.page(artifact.id).snapshot, target = original.nodes.find(n => n.type === 'TEXT')!
  const thread = comments.create(artifact.id, { id: randomUUID(), expectedRevision: 0, anchor: { kind: 'object', slideId: original.frameId, nodeId: target.id }, body: 'Shorten the heading.' })
  const batch = { kind: 'page', artifactId: artifact.id, expectedRevision: 0, operations: [{ op: 'update_page_element', id: target.id, props: { text: 'Reviewed heading' } }] }
  let round = 0, saved = 0
  const provider: Provider = async (messages, _signal, text) => {
    if (round === 0) {
      assert.match(JSON.stringify(messages), /untrusted comment/)
      assert.match(JSON.stringify(messages), /Shorten the heading/)
    }
    if (round === 1 || round === 3) assert.match(JSON.stringify(messages.at(-1)), /Read current artifact/)
    switch (round++) {
      case 0: return [tool('apply_batch', batch)]
      case 1: return [tool('read_context', { artifactId: artifact.id, view: 'selection' })]
      case 2: return [tool('apply_batch', batch)]
      case 3: return [tool('read_context', { artifactId: artifact.id, view: 'page' })]
      case 4: return [tool('apply_batch', batch)]
      default: text('Updated the heading.'); return [{ type: 'text', text: 'Updated the heading.', citations: null }]
    }
  }
  const app = createApp(store, provider), url = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const response = await fetch(`${url}/api/conversations/${conversation.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Address this page comment', artifactId: artifact.id, commentThreadId: thread.id, expectedCommentVersion: thread.version }),
    })
    await consume(response, async command => {
      if (command.name === 'read_context') return { ok: true, data: { revision: ws.page(artifact.id).revision } }
      const input = artifactBatchSchema.parse(command.input)
      assert.equal(input.kind, 'page')
      const parsed = pageBatchSchema.parse({ expectedRevision: input.expectedRevision, operations: input.operations })
      const graph = new SceneGraph(), current = ws.page(artifact.id).snapshot
      restorePage(graph, current)
      const meta = { title: current.title, frameId: current.frameId, pageId: current.pageId }
      applyPageOperations(graph, meta, parsed.operations)
      const result = await app.inject({
        method: 'PUT', url: `/api/conversations/${conversation.id}/artifacts/${artifact.id}`,
        payload: { expectedRevision: input.expectedRevision, commandId: command.id, snapshot: capturePage(graph, meta) },
      })
      assert.equal(result.statusCode, 200, result.body)
      saved++
      return { ok: true, data: result.json() }
    }, async (run, command, result) => {
      assert.equal((await app.inject({ method: 'POST', url: `/api/workspace-runs/${run}/commands/${command}`, payload: result })).statusCode, 200)
    })
    assert.equal(saved, 1)
    assert.equal(ws.page(artifact.id).revision, 1)
    assert.equal(comments.get(artifact.id, thread.id).resolved, false)
    assert.equal(ws.page(artifact.id).snapshot.nodes.find(n => n.id === target.id)!.text, 'Reviewed heading')
  } finally { await app.close(); store.close() }
})
