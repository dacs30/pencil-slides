import Fastify from 'fastify'
import staticPlugin from '@fastify/static'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { saveSchema, snapshotSchema, type Command, type ToolResult } from '../shared/model.js'
import { Store, Conflict } from './store.js'
import { anthropicProvider, runAgent, type Provider } from './agent.js'
import type { ChatDetails, ToolActivity } from '../shared/chat.js'
import { chatRequestSchema, commentRouteSchema } from '../shared/comments.js'
import { CommentStore } from './comments.js'

type Pending = { command: Command; resolve: (result: ToolResult) => void }
type Run = { deckId: string; controller: AbortController; pending: Map<string, Pending>; requiredSlideId?: string; readRevision?: number }
export function createApp(store: Store, provider?: Provider) {
  const app = Fastify({ bodyLimit: 12 * 1024 * 1024, logger: false })
  const runs = new Map<string, Run>()
  const comments = new CommentStore(store)
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host || ''
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return reply.code(403).send({ error: 'Localhost only' })
    const origin = request.headers.origin
    if (origin) {
      const allowed = new Set([`http://${host}`, 'http://127.0.0.1:5173', 'http://localhost:5173'])
      if (!allowed.has(origin)) return reply.code(403).send({ error: 'Origin not allowed' })
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Cross-site requests forbidden' })
  })
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode
    reply.code(error instanceof Conflict ? 409 : error instanceof z.ZodError ? 400 : status && status >= 400 && status <= 599 ? status : 500)
      .send({ error: error instanceof Error ? error.message : 'Request failed' })
  })
  app.get('/api/health', async () => ({ ok: true, aiConfigured: Boolean(provider || process.env.ANTHROPIC_API_KEY) }))
  app.get('/api/decks', async () => store.list())
  app.post('/api/decks', async request => store.create(snapshotSchema.parse(request.body)))
  app.get<{ Params: { id: string } }>('/api/decks/:id', async request => store.get(request.params.id))
  app.put<{ Params: { id: string } }>('/api/decks/:id', async request => {
    const body = saveSchema.parse(request.body)
    const run = [...runs.values()].find(r => r.deckId === request.params.id)
    if (body.commandId.startsWith('ai:') && !run) throw new Conflict('AI command expired or run cancelled')
    if (run) {
      const command = run.pending.get(body.commandId)?.command
      if (!command || command.name !== 'apply_batch') throw new Conflict('Deck is locked by an AI run')
      if ((command.input as { expectedRevision: number }).expectedRevision !== body.expectedRevision) throw new Conflict('Command revision mismatch')
    }
    return store.save(request.params.id, body.expectedRevision, body.snapshot, body.commandId)
  })
  app.get<{ Params: { id: string; command: string } }>('/api/decks/:id/commands/:command', async request => ({
    committed: store.committed(request.params.command, request.params.id) ?? null,
  }))
  app.get<{ Params: { id: string } }>('/api/decks/:id/chat', async request => store.messages(request.params.id))
  app.get<{ Params: { id: string } }>('/api/decks/:id/comments', async request => comments.list(commentRouteSchema.parse(request.params).id))
  app.post<{ Params: { id: string } }>('/api/decks/:id/comments', async request => comments.create(commentRouteSchema.parse(request.params).id, request.body))
  app.post<{ Params: { id: string; threadId: string } }>('/api/decks/:id/comments/:threadId/replies', async request => {
    const params = commentRouteSchema.parse(request.params)
    return comments.reply(params.id, params.threadId!, request.body)
  })
  app.patch<{ Params: { id: string; threadId: string } }>('/api/decks/:id/comments/:threadId', async request => {
    const params = commentRouteSchema.parse(request.params)
    return comments.resolve(params.id, params.threadId!, request.body)
  })
  app.post<{ Params: { run: string; command: string } }>('/api/runs/:run/commands/:command', async (request, reply) => {
    const run = runs.get(request.params.run)
    const pending = run?.pending.get(request.params.command)
    if (!run || !pending) return reply.code(410).send({ error: 'Command expired or run cancelled' })
    let result = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().max(5000).optional() }).strict().parse(request.body)
    if (pending.command.name === 'apply_batch' && result.ok) {
      const commit = store.committed(pending.command.id, run.deckId)
      result = commit ? { ok: true, data: { revision: commit.revision, deck: store.get(run.deckId).snapshot.slides } }
        : { ok: false, error: 'Browser acknowledged without a durable save' }
    }
    pending.resolve(result)
    return { ok: true }
  })
  app.post<{ Params: { run: string } }>('/api/runs/:run/cancel', async request => {
    runs.get(request.params.run)?.controller.abort(new Error('Cancelled by user'))
    return { ok: true }
  })
  app.post<{ Params: { id: string } }>('/api/decks/:id/chat', async (request, reply) => {
    const { message, commentThreadId, expectedCommentVersion } = chatRequestSchema.parse(request.body)
    const deckId = request.params.id
    store.get(deckId)
    const handoff = commentThreadId ? comments.handoff(deckId, commentThreadId, expectedCommentVersion!) : undefined
    if ([...runs.values()].some(r => r.deckId === deckId)) throw new Conflict('A run is already active for this deck')
    const actualProvider = provider ?? anthropicProvider()
    const runId = randomUUID()
    const controller = new AbortController()
    const run: Run = { deckId, controller, pending: new Map(), requiredSlideId: handoff?.slideId }
    runs.set(runId, run)
    const timeout = setTimeout(() => controller.abort(new Error('Run timed out after 120 seconds')), 120_000)
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const emit = (event: string, data: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const disconnect = () => controller.abort(new Error('Browser disconnected'))
    reply.raw.on('close', disconnect)
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n') }, 10_000)
    emit('run', { id: runId })
    store.append(deckId, 'user', message)
    const history = store.messages(deckId).map(({ role, content }) => ({ role, content }))
    while (history[0]?.role === 'assistant') history.shift()
    if (handoff) history[history.length - 1]!.content = `${message}\n\n${handoff.content}`
    let transcript = ''
    const details: Required<ChatDetails> = { activities: [], artifacts: [] }
    try {
      await runAgent({
        provider: actualProvider, messages: history, signal: controller.signal,
        emit: (event, data) => {
          if (event === 'text') transcript += (data as { text: string }).text
          if (event === 'tool_result') {
            const result = data as ToolResult & { commandId: string; name: string; data?: { revision?: number } }
            const activity: ToolActivity = { id: result.commandId, name: result.name, status: result.ok ? 'complete' : 'failed', ...(result.error ? { error: result.error } : {}) }
            if (result.name === 'apply_batch' && result.ok && result.data?.revision !== undefined) {
              const snapshot = store.get(deckId).snapshot
              activity.revision = result.data.revision
              const artifact = { title: snapshot.title, revision: result.data.revision, slideIds: snapshot.slides.map(s => s.id) }
              details.artifacts.push(artifact)
              emit('artifact', artifact)
            }
            details.activities.push(activity)
          }
          emit(event, data)
        },
        execute: async command => {
          if (run.requiredSlideId && command.name === 'apply_batch') {
            const revision = (command.input as { expectedRevision: number }).expectedRevision
            if (run.readRevision !== revision || store.get(deckId).revision !== revision) {
              return { ok: false, error: `Read current slide context first: read_context with view "slide" and slideId "${run.requiredSlideId}". Use that revision before mutating.` }
            }
          }
          const result = await new Promise<ToolResult>(resolveResult => {
          let timer: ReturnType<typeof setTimeout>
          const finish = (result: ToolResult) => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', abort)
            run.pending.delete(command.id)
            resolveResult(result)
          }
          const abort = () => finish({ ok: false, error: 'Run cancelled; any already committed batch remains saved' })
          timer = setTimeout(() => finish({ ok: false, error: 'Editor command timed out after 30 seconds; read context before retrying' }), 30_000)
          controller.signal.addEventListener('abort', abort, { once: true })
          run.pending.set(command.id, { command, resolve: finish })
          if (controller.signal.aborted) abort()
          else emit('command', command)
          })
          if (run.requiredSlideId && command.name === 'read_context' && result.ok) {
            const input = command.input as { view: string; slideId?: string }
            const revision = (result.data as { revision?: number } | undefined)?.revision
            if (input.view === 'slide' && input.slideId === run.requiredSlideId && revision === store.get(deckId).revision) run.readRevision = revision
          }
          return result
        },
      })
      emit('done', {})
    } catch (e) {
      const error = e instanceof Error ? e.message : 'AI run failed'
      transcript += `\n[${error}]`
      emit('error', { error })
    } finally {
      if (transcript || details.activities.length) store.append(deckId, 'assistant', transcript, details)
      clearTimeout(timeout)
      clearInterval(heartbeat)
      runs.delete(runId)
      reply.raw.off('close', disconnect)
      reply.raw.end()
    }
  })
  app.addHook('onClose', async () => {
    for (const run of runs.values()) run.controller.abort()
  })
  const dist = resolve('dist')
  if (existsSync(dist)) app.register(staticPlugin, { root: dist })
  return app
}
