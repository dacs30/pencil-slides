import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deleteDB } from 'idb'
import { createBrowserApp } from '../server/browser-app.js'
import { BrowserStore } from '../src/local-store.js'
import { workspaceProvider } from './workspace-provider.js'
import { artifactBatchSchema, artifactReadSchema, createArtifactSchema, type ArtifactCommand } from '../shared/artifacts.js'
import { applyTextBatch } from '../shared/rich-text.js'
import type { ToolResult } from '../shared/model.js'
import type { Provider } from '../server/agent.js'
import type Anthropic from '@anthropic-ai/sdk'

async function stream(response: Response, execute: (command: ArtifactCommand, run: string, token: string) => Promise<ToolResult>, acknowledge: (run: string, token: string, command: string, result: ToolResult) => Promise<void>) {
  assert.equal(response.status, 200)
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  const events: { event: string; data: Record<string, unknown> }[] = []
  let buffer = '', run = '', token = ''
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
      if (event === 'run') { run = data.id; token = data.token }
      if (event === 'command') await acknowledge(run, token, data.id, await execute(data, run, token))
    }
    if (done) break
  }
  return { events, run, token }
}
test('hosted origin configuration permits Render HTTPS without exposing workspace data routes', async () => {
  const app = createBrowserApp(undefined, { publicOrigin: 'https://pencil.example', serveStatic: false })
  try {
    assert.equal((await app.inject({ url: '/api/health', headers: { host: 'pencil.example', origin: 'https://pencil.example' } })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/health', headers: { host: 'evil.example' } })).statusCode, 403)
    assert.equal((await app.inject({ url: '/api/health', headers: { host: 'pencil.example', origin: 'https://evil.example' } })).statusCode, 403)
    assert.equal((await app.inject({ url: '/api/health' })).json().storage, 'browser')
    const crossSite = { host: 'pencil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }
    assert.equal((await app.inject({ url: '/api/health', headers: crossSite })).statusCode, 403)
    assert.notEqual((await app.inject({ url: '/', headers: crossSite })).statusCode, 403)
    for (const url of ['/api/conversations', '/api/decks', '/api/conversations/anything/artifacts/anything']) assert.equal((await app.inject({ url })).statusCode, 404)
    assert.throws(() => createBrowserApp(undefined, { publicOrigin: 'https://pencil.example/path' }), /PUBLIC_ORIGIN/)
  } finally { await app.close() }
})
test('stateless relay lets browser-owned IndexedDB create and save both artifact kinds', async () => {
  const name = `relay-test-${randomUUID()}`, store = new BrowserStore(name)
  const conversation = await store.createConversation()
  const app = createBrowserApp(workspaceProvider, { serveStatic: false })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const result = await stream(await fetch(`${address}/api/conversations/${conversation.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Create both a document and slides', history: [], artifacts: [] }),
    }), async (command, run, token) => {
      assert.equal((await app.inject({ method: 'POST', url: `/api/workspace-runs/${run}/cancel`, headers: { authorization: 'Bearer wrong' } })).statusCode, 401)
      assert(token)
      if (command.name === 'create_artifact') {
        const artifact = await store.createArtifact(conversation.id, createArtifactSchema.parse(command.input), command.id)
        return { ok: true, data: { ...artifact, artifactId: artifact.id, commandId: command.id, durable: true } }
      }
      if (command.name === 'read_context') {
        const input = artifactReadSchema.parse(command.input)
        if (input.view === 'workspace') return { ok: true, data: await store.conversation(conversation.id) }
        const artifact = await store.open(conversation.id, input.artifactId!)
        if (artifact.kind === 'page') throw new Error('Wrong fixture kind')
        return { ok: true, data: {
          artifactId: artifact.value.id, kind: artifact.kind, revision: artifact.value.revision,
          ...(artifact.kind === 'document' ? { content: artifact.value.snapshot.content, selection: { from: 1, to: 1 } } : { slides: artifact.value.snapshot.slides }),
        } }
      }
      const input = artifactBatchSchema.parse(command.input), artifact = await store.open(conversation.id, input.artifactId)
      let payload: unknown
      if (input.kind === 'document' && artifact.kind === 'document') payload = { expectedRevision: input.expectedRevision, commandId: command.id, ...applyTextBatch(artifact.value.snapshot, input.operations) }
      else if (input.kind === 'slides' && artifact.kind === 'slides') {
        const snapshot = structuredClone(artifact.value.snapshot)
        snapshot.slides[0]!.title = 'The companion slide deck'
        payload = { expectedRevision: input.expectedRevision, commandId: command.id, snapshot }
      } else throw new Error('Wrong fixture kind')
      const committed = await store.save(conversation.id, input.artifactId, payload)
      return { ok: true, data: { artifactId: input.artifactId, kind: artifact.kind, revision: committed.revision, title: artifact.value.snapshot.title, durable: true, commandId: command.id } }
    }, async (run, token, command, result) => {
      assert.equal((await app.inject({ method: 'POST', url: `/api/workspace-runs/${run}/commands/${command}`, headers: { authorization: `Bearer ${token}` }, payload: result })).statusCode, 200)
    })
    assert(result.events.some(e => e.event === 'done'))
    assert(!result.events.some(e => e.event === 'error'))
    assert((await store.conversation(conversation.id)).artifacts.every(a => a.revision === 1))
    assert.equal((await app.inject({ method: 'POST', url: `/api/workspace-runs/${result.run}/cancel`, headers: { authorization: `Bearer ${result.token}` } })).statusCode, 401)
    assert.equal((await app.inject({ url: `/api/conversations/${conversation.id}` })).statusCode, 404)
  } finally { await app.close(); await store.close(); await deleteDB(name) }
})
test('relay rejects unmatched commit acknowledgements rather than claiming a browser save', async () => {
  let round = 0
  const provider: Provider = async (messages, _signal, text) => {
    const tool = (name: string, input: unknown): Anthropic.ToolUseBlock => ({ type: 'tool_use', id: `call-${round}`, name, input, caller: { type: 'direct' } })
    switch (round++) {
      case 0: return [tool('read_context', { artifactId: 'fixture', view: 'page' })]
      case 1: return [tool('apply_batch', { artifactId: 'fixture', kind: 'page', expectedRevision: 0, operations: [{ op: 'update_page', title: 'Change' }] })]
      default:
        assert.match(JSON.stringify(messages.at(-1)), /matching durable IndexedDB commit/)
        text('No save was confirmed.'); return []
    }
  }
  const app = createBrowserApp(provider, { serveStatic: false }), address = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const result = await stream(await fetch(`${address}/api/conversations/test/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Edit', history: [], artifactId: 'fixture', artifacts: [{ id: 'fixture', kind: 'page', title: 'Page', revision: 0 }] }),
    }), async command => ({ ok: true, data: { artifactId: 'fixture', kind: 'page', revision: command.name === 'read_context' ? 0 : 1, commandId: 'wrong-command', durable: true } }),
    async (run, token, command, result) => {
      await app.inject({ method: 'POST', url: `/api/workspace-runs/${run}/commands/${command}`, headers: { authorization: `Bearer ${token}` }, payload: result })
    })
    assert(result.events.some(e => e.event === 'tool_result' && e.data.ok === false))
  } finally { await app.close() }
})

test('only the initiating run capability can cancel an active stateless AI request', async () => {
  let aborted = false
  const provider: Provider = async (_messages, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })
  })
  const app = createBrowserApp(provider, { serveStatic: false }), address = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    const response = await fetch(`${address}/api/conversations/fixture/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Wait until cancelled', history: [], artifacts: [] }),
    })
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let buffer = ''
    while (!buffer.includes('\n\n')) {
      const value = await reader.read()
      if (value.done) throw new Error('Missing run announcement')
      buffer += decoder.decode(value.value, { stream: true })
    }
    const run = JSON.parse(buffer.match(/^data: (.+)$/m)![1]!)
    assert.equal((await app.inject({ method: 'POST', url: `/api/workspace-runs/${run.id}/cancel` })).statusCode, 401)
    assert.equal(aborted, false)
    assert.equal((await app.inject({ method: 'POST', url: `/api/workspace-runs/${run.id}/cancel`, headers: { authorization: `Bearer ${run.token}` } })).statusCode, 200)
    while (!(await reader.read()).done) { /* Drain the relay's cancellation response. */ }
    assert.equal(aborted, true)
    assert.equal((await app.inject({ method: 'POST', url: `/api/workspace-runs/${run.id}/cancel`, headers: { authorization: `Bearer ${run.token}` } })).statusCode, 401)
  } finally { await app.close() }
})
