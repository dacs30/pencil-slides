import { test } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { createAnthropicProvider, runToolLoop, type Provider, type ProviderReply } from '../server/agent.js'
import { validateArtifactTool } from '../shared/artifacts.js'

const batch: Anthropic.ToolUseBlock = {
  type: 'tool_use', id: 'batch', name: 'apply_batch', caller: { type: 'direct' },
  input: { kind: 'page', artifactId: 'fixture', expectedRevision: 0, operations: [{ op: 'update_page', title: 'Complete edit' }] },
}
test('the agent can complete beyond ten rounds, including a final response after thirty tool calls', async () => {
  let rounds = 0, executions = 0
  const result = await runToolLoop({
    provider: async (_messages, _signal, text) => {
      if (++rounds <= 30) return [batch]
      text('Completed all batches.')
      return [{ type: 'text', text: 'Completed all batches.', citations: null }]
    },
    messages: [{ role: 'user', content: 'Build a page in small batches' }],
    signal: new AbortController().signal, emit: () => {}, validate: validateArtifactTool,
    execute: async () => { executions++; return { ok: true } },
  })
  assert.equal(rounds, 31)
  assert.equal(executions, 30)
  assert.equal(result, 'Completed all batches.')
})
test('the real SDK provider preserves max_tokens when incomplete input loses its operations property', async () => {
  const events = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_fixture', name: 'apply_batch', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"kind":"page","artifactId":"fixture","expectedRevision":0,"operations":' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 4096 } },
    { type: 'message_stop' },
  ]
  const client = new Anthropic({
    apiKey: 'synthetic-test-key',
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      assert.match(request.system, /top-level operations array/)
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const reply = await createAnthropicProvider(client)([{ role: 'user', content: 'Create a fixture page' }], new AbortController().signal, () => {})
  assert(!Array.isArray(reply))
  assert.equal(reply.stopReason, 'max_tokens')
  const call = reply.content[0]
  assert(call?.type === 'tool_use')
  assert.deepEqual(call.input, { kind: 'page', artifactId: 'fixture', expectedRevision: 0 })
})
test('no tools from a truncated response run; the model receives feedback and can retry a smaller complete batch', async () => {
  let round = 0, executions = 0
  const results: unknown[] = []
  const provider: Provider = async messages => {
    if (++round === 1) return { content: [batch, { ...batch, id: 'also-incomplete' }], stopReason: 'max_tokens' }
    if (round === 2) {
      const responses = messages.at(-1)!.content
      assert(Array.isArray(responses))
      assert.equal(responses.length, 2)
      for (const response of responses) {
        assert(response.type === 'tool_result')
        assert.equal(response.is_error, true)
        assert.match(String(response.content), /No tools from this response were executed/)
      }
      return { content: [batch], stopReason: 'tool_use' }
    }
    return []
  }
  await runToolLoop({
    provider, messages: [{ role: 'user', content: 'Create a page' }], signal: new AbortController().signal,
    emit: (event, value) => { if (event === 'tool_result') results.push(value) },
    validate: validateArtifactTool,
    execute: async () => { executions++; return { ok: true, data: { revision: 1 } } },
  })
  assert.equal(executions, 1)
  assert.equal(results.length, 3)
})
test('repeated output truncation stops with an explicit error rather than cycling through schema failures', async () => {
  let executions = 0, calls = 0
  await assert.rejects(runToolLoop({
    provider: async (): Promise<ProviderReply> => { calls++; return { content: [batch], stopReason: 'max_tokens' } },
    messages: [{ role: 'user', content: 'Create a page' }], signal: new AbortController().signal,
    emit: () => {}, validate: validateArtifactTool,
    execute: async () => { executions++; return { ok: true } },
  }), /repeatedly exceeded its output limit/)
  assert.equal(calls, 3)
  assert.equal(executions, 0)
})
