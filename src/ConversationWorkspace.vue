<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import Workspace from './Workspace.vue'
import DocumentEditor from './DocumentEditor.vue'
import PageEditor from './PageEditor.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import { api } from './api'
import { artifactReadSchema, artifactBatchSchema, createArtifactSchema, upsertArtifactCard, restoreWorkspaceMessage, type Conversation, type OpenArtifact, type ArtifactKind, type ArtifactInfo, type WorkspaceMessage, type ArtifactAdapter, type ArtifactCommand } from '../shared/artifacts'
import { browserStore } from './local-store'
import { prepareBrowserChat, committedBrowserResult, MessageWriter } from './browser-chat'
import type { ToolResult } from '../shared/model'
import type { CommentHandoff } from '../shared/comments'

const props = defineProps<{ conversation: Conversation }>()
const emit = defineEmits<{ refresh: []; lock: [locked: boolean] }>()
const artifacts = ref(props.conversation.artifacts), active = ref<OpenArtifact>(), adapter = ref<ArtifactAdapter>()
const messages = ref<WorkspaceMessage[]>([]), prompt = ref(''), error = ref(''), busy = ref(false), running = ref(false), childLocked = ref(false)
const aiConfigured = ref(false), aiError = ref(''), selection = ref<unknown>(), chatScroll = ref<HTMLElement>()
const base = `/conversations/${props.conversation.id}`
const locked = computed(() => busy.value || running.value || childLocked.value)
let controller: AbortController | undefined, runId = '', runToken = '', followChat = true
let writer: MessageWriter | undefined
const activeId = computed(() => active.value?.value.id)
const saveBase = computed(() => `${base}/artifacts/${activeId.value}`)
const selectionLabel = computed(() => {
  const s = selection.value as { text?: string; selectedIds?: string[]; name?: string } | undefined
  if (s?.text) return `Selected: ${s.text.slice(0, 100)}`
  if (s?.selectedIds?.length) return `${s.selectedIds.length} selected: ${s.name ?? 'slide objects'}`
  return ''
})
function reportLock(value = childLocked.value) { childLocked.value = value; emit('lock', locked.value) }
async function refresh() { artifacts.value = (await api<Conversation>(base)).artifacts; emit('refresh') }
async function saved() { try { await refresh() } catch (e) { error.value = String(e) } }
async function open(id: string, forCommand = false) {
  if (activeId.value === id) return
  if (!forCommand && locked.value) return
  await adapter.value?.flush()
  busy.value = true; emit('lock', true)
  try {
    const value = await api<OpenArtifact>(`${base}/artifacts/${id}`)
    selection.value = undefined; childLocked.value = false; active.value = value
    localStorage.setItem(`pencil:active:${props.conversation.id}`, id)
    await nextTick()
    // Vue's editor composable initializes on mount.
    if (value.kind === 'document') await nextTick()
  } finally { busy.value = false; reportLock() }
}
async function choose(id: string) { try { await open(id) } catch (e) { error.value = String(e) } }
async function create(kind: ArtifactKind) {
  if (locked.value) return
  busy.value = true; emit('lock', true)
  const commandId = crypto.randomUUID()
  try {
    const body = JSON.stringify({ kind, title: kind === 'slides' ? 'Untitled deck' : kind === 'page' ? 'Untitled page' : 'Untitled document', commandId })
    let artifact: ArtifactInfo
    try { artifact = await api(`${base}/artifacts`, { method: 'POST', body }) }
    catch { artifact = await api(`${base}/artifacts`, { method: 'POST', body }) }
    await refresh(); await open(artifact.id, true)
  } catch (e) { error.value = String(e) }
  finally { busy.value = false; reportLock() }
}
async function execute(command: ArtifactCommand): Promise<ToolResult> {
  try {
    if (command.name === 'create_artifact') {
      const input = createArtifactSchema.parse(command.input)
      const artifact = await browserStore.createArtifact(props.conversation.id, input, command.id)
      await refresh()
      return committedBrowserResult(props.conversation.id, artifact.id, command.id, { ok: true })
    }
    const parsed = command.name === 'read_context' ? artifactReadSchema.parse(command.input) : artifactBatchSchema.parse(command.input)
    if ('view' in parsed && parsed.view === 'workspace') return { ok: true, data: { ...await browserStore.conversation(props.conversation.id), activeArtifactId: activeId.value } }
    if (!parsed.artifactId) throw new Error('Command is missing its artifact ID.')
    if (parsed.artifactId !== activeId.value) await open(parsed.artifactId, true)
    if (!adapter.value) throw new Error('Artifact editor is not ready.')
    if (command.name === 'read_context') {
      const { artifactId: _id, ...input } = artifactReadSchema.parse(parsed)
      if (active.value?.kind === 'slides' && !['deck', 'slide', 'selection'].includes(input.view)) throw new Error('Choose deck, slide or selection for a slide artifact.')
      if (active.value?.kind === 'document' && !['document', 'selection'].includes(input.view)) throw new Error('Choose document or selection for a text artifact.')
      if (active.value?.kind === 'page' && !['page', 'selection'].includes(input.view)) throw new Error('Choose page or selection for a page artifact.')
      const result = await adapter.value.execute({ ...command, name: 'read_context', input })
      if (!result.ok) return result
      if (!result.data || typeof result.data !== 'object') throw new Error('Invalid editor context.')
      return { ok: true, data: { ...result.data, artifactId: parsed.artifactId, kind: active.value!.kind } }
    }
    const { artifactId: _id, kind, ...input } = artifactBatchSchema.parse(parsed)
    if (active.value?.kind !== kind) throw new Error('Artifact kind mismatch.')
    return committedBrowserResult(props.conversation.id, parsed.artifactId, command.id, await adapter.value.execute({ ...command, name: 'apply_batch', input }))
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}
async function scrollChat() { await nextTick(); if (followChat && chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight }
function trackScroll() { const el = chatScroll.value; if (el) followChat = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
async function send(handoff?: CommentHandoff) {
  const text = handoff?.message ?? prompt.value.trim()
  if (!text || locked.value || !aiConfigured.value) return
  try { await adapter.value?.flush() } catch (e) { error.value = String(e); return }
  let request: Awaited<ReturnType<typeof prepareBrowserChat>>
  try { request = await prepareBrowserChat(props.conversation.id, text, activeId.value, messages.value, handoff) }
  catch (e) { error.value = String(e); return }
  running.value = true; emit('lock', true); error.value = ''; followChat = true
  if (!handoff) prompt.value = ''
  messages.value.push({ role: 'user', content: text }, { role: 'assistant', content: '', runState: 'running', activities: [], artifacts: [] })
  const message = messages.value.at(-1)!
  const messageId = crypto.randomUUID(), userMessageId = crypto.randomUUID()
  controller = new AbortController()
  runId = ''; runToken = ''
  writer = new MessageWriter(props.conversation.id, messageId, () => message, failure => {
    error.value = `Chat could not be saved in this browser: ${failure instanceof Error ? failure.message : failure}`
    controller?.abort(new Error(error.value))
  })
  let completed = false
  try {
    await browserStore.putMessage(props.conversation.id, userMessageId, { role: 'user', content: text })
    await browserStore.putMessage(props.conversation.id, messageId, message)
    const response = await fetch(`/api${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal })
    if (!response.ok) throw new Error((await response.json()).error ?? 'Chat failed.')
    if (!response.body) throw new Error('Missing chat stream.')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const event = packet.match(/^event: (.+)$/m)?.[1], raw = packet.match(/^data: (.+)$/m)?.[1]
        if (!event || !raw) continue
        const data = JSON.parse(raw)
        if (event === 'run') { runId = data.id; runToken = data.token }
        if (event === 'text') message.content += data.text
        if (event === 'error') throw new Error(data.error)
        if (event === 'done') completed = true
        if (event === 'artifact') { upsertArtifactCard(message.artifacts!, data); await refresh() }
        if (event === 'command') {
          message.activities!.push({ id: data.id, name: data.name, status: 'running' })
          const result = await execute(data)
          if (result.error && result.error.length > 5000) result.error = result.error.slice(0, 4950) + '\n[Error details shortened.]'
          await api(`/workspace-runs/${runId}/commands/${data.id}`, { method: 'POST', headers: { Authorization: `Bearer ${runToken}` }, body: JSON.stringify(result) })
        }
        if (event === 'tool_result') {
          const activity = { id: data.commandId, name: data.name, status: data.ok ? 'complete' as const : 'failed' as const, error: data.error, revision: data.data?.revision }
          const i = message.activities!.findIndex(a => a.id === activity.id)
          if (i < 0) message.activities!.push(activity); else message.activities![i] = activity
        }
        writer.changed()
        if (event === 'artifact' || event === 'tool_result') await writer.flush()
        await scrollChat()
      }
      if (done) break
    }
    if (!completed) throw new Error('Chat stream ended before completion. Already saved changes are retained.')
  } catch (e) {
    error.value = controller.signal.aborted ? controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError' ? controller.signal.reason.message : 'Cancelled. Browser-saved changes are retained.' : String(e)
    message.content += `\n${error.value}`
    if (runId && runToken) await api(`/workspace-runs/${runId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${runToken}` } }).catch(cancelError => { error.value += ` Cancellation failed: ${cancelError}` })
  } finally {
    message.runState = completed ? 'complete' : 'interrupted'
    for (const a of message.activities ?? []) if (a.status === 'running') { a.status = 'interrupted'; a.error = 'Interrupted; inspect the saved artifact.' }
    writer.changed()
    await writer.flush().catch(e => { error.value = `Chat could not be saved in this browser: ${String(e)}` })
    running.value = false; controller = undefined; runId = ''; runToken = ''; writer = undefined; reportLock()
    await refresh().catch(e => { error.value = String(e) })
  }
}
async function cancel() {
  try { if (runId) await api(`/workspace-runs/${runId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${runToken}` } }) }
  catch (e) { error.value = String(e) }
  controller?.abort()
}
function unload(e: BeforeUnloadEvent) { if (locked.value || prompt.value.trim()) { e.preventDefault(); e.returnValue = '' } }
onMounted(async () => {
  window.addEventListener('beforeunload', unload)
  void api<{ aiConfigured: boolean }>('/health').then(health => { aiConfigured.value = health.aiConfigured; aiError.value = '' })
    .catch(error => { aiConfigured.value = false; aiError.value = `AI service unavailable: ${String(error)}. Browser editing and exports remain available.` })
  busy.value = true; emit('lock', true)
  try {
    messages.value = (await api<WorkspaceMessage[]>(`${base}/messages`)).map(restoreWorkspaceMessage)
    const previous = localStorage.getItem(`pencil:active:${props.conversation.id}`)
    const first = artifacts.value.find(a => a.id === previous) ?? artifacts.value[0]
    if (first) await open(first.id, true)
    await scrollChat()
  } catch (e) { error.value = String(e) }
  finally { busy.value = false; reportLock() }
})
onUnmounted(() => { controller?.abort(); void writer?.flush().catch(() => { /* The writer reports storage failures. */ }); window.removeEventListener('beforeunload', unload) })
</script>

<template>
  <div class="workspace">
    <aside class="chat-panel" aria-label="Workspace conversation">
      <div class="conversation-heading"><span class="eyebrow">YOUR WRITING &amp; DESIGN PARTNER</span></div>
      <div ref="chatScroll" class="chat-scroll" @scroll="trackScroll">
        <section v-if="!messages.length" class="chat-welcome">
          <div class="welcome-mark" aria-hidden="true">p/</div><h1>One idea.<br>Many ways to tell it.</h1>
          <p>Create a presentation, write a document, or design a page in one conversation.</p>
          <button :disabled="locked" @click="prompt = 'Create a document outlining a three-slide pitch for a neighborhood bike repair shop, then create the slide deck.'">Start with a document and a deck</button>
        </section>
        <div class="messages" aria-live="polite">
          <article v-for="(message, i) in messages" :key="i" :class="['message', message.role]">
            <div class="message-author">{{ message.role === 'user' ? 'You' : 'Pencil' }}</div>
            <MarkdownMessage v-if="message.role === 'assistant' && message.content" :content="message.content" />
            <p v-else>{{ message.content || (running && i === messages.length - 1 ? 'Working on your request...' : '') }}</p>
            <details v-if="message.activities?.length" class="tool-activity">
              <summary>{{ message.activities.filter(a => a.status === 'complete').length }} of {{ message.activities.length }} editor actions completed</summary>
              <ul><li v-for="activity in message.activities" :key="activity.id"><div><strong>{{ activity.name }}: {{ activity.status }}</strong><small>{{ activity.error || (activity.revision !== undefined ? `${activity.name === 'read_context' ? 'Read' : 'Saved in browser'} revision ${activity.revision}` : '') }}</small></div></li></ul>
            </details>
            <button v-for="artifact in message.artifacts" :key="artifact.id" class="artifact-card" :disabled="locked" @click="choose(artifact.id)" :aria-label="`Open ${artifact.kind}: ${artifact.title}`">
              <span class="artifact-card-icon">{{ artifact.kind === 'document' ? 'T' : artifact.kind === 'page' ? 'P' : '▧' }}</span>
              <span class="artifact-card-copy"><strong>{{ artifact.title }}</strong><small>{{ artifact.kind === 'document' ? 'Document' : artifact.kind === 'page' ? 'Page design' : 'Slide deck' }} · saved r{{ artifact.revision }}</small><span>Open current artifact</span></span>
            </button>
          </article>
        </div>
      </div>
      <div class="composer-area">
        <div v-if="error" class="error" role="alert">{{ error }}</div>
        <details v-if="!aiConfigured" class="key-notice"><summary>{{ aiError ? 'AI service unavailable' : 'Connect Claude to start a conversation' }}</summary><p>{{ aiError || 'Set ANTHROPIC_API_KEY on the server and restart. Editing, comments, and export work without a key.' }}</p></details>
        <form class="composer" @submit.prevent="send()">
          <div v-if="selectionLabel" class="selection-context">{{ selectionLabel }}</div>
          <textarea aria-label="Message Claude" v-model="prompt" placeholder="What would you like to create or change?" :disabled="running" @keydown.ctrl.enter.prevent="send()" @keydown.meta.enter.prevent="send()" />
          <div class="composer-footer"><span class="model-label">Claude · Your creative partner</span><button v-if="running" type="button" @click="cancel">Stop</button><button v-else aria-label="Send message" :disabled="locked || !aiConfigured || !prompt.trim()">Send</button></div>
        </form>
        <p class="privacy-note">Saved in this browser. AI receives context when you send.</p>
      </div>
    </aside>
    <section class="artifact-workspace" aria-label="Conversation artifacts">
      <nav class="artifact-switcher" aria-label="Artifacts">
        <select aria-label="Choose artifact" :value="activeId ?? ''" :disabled="locked || !artifacts.length" @change="choose(($event.target as HTMLSelectElement).value)">
          <option v-if="!artifacts.length" value="">No artifacts yet</option>
          <option v-for="artifact in artifacts" :key="artifact.id" :value="artifact.id">{{ artifact.kind === 'document' ? 'Doc' : artifact.kind === 'page' ? 'Page' : 'Slides' }}: {{ artifact.title }}</option>
        </select>
        <button :disabled="locked" @click="create('document')">+ Document</button><button :disabled="locked" @click="create('slides')">+ Slide deck</button><button :disabled="locked" @click="create('page')">+ Page</button>
      </nav>
      <Workspace v-if="active?.kind === 'slides'" :key="active.value.id" ref="adapter" :deck="active.value" embedded :external-busy="running" :save-base="saveBase" @saved="saved" @lock="reportLock" @handoff="send" @selection="selection = $event" />
      <DocumentEditor v-else-if="active?.kind === 'document'" :key="active.value.id" ref="adapter" :document="active.value" :save-base="saveBase" :external-busy="running" :ai-configured="aiConfigured" @saved="saved" @lock="reportLock" @handoff="send" @selection="selection = $event" />
      <PageEditor v-else-if="active?.kind === 'page'" :key="active.value.id" ref="adapter" :page="active.value" :save-base="saveBase" :external-busy="running" :ai-configured="aiConfigured" @saved="saved" @lock="reportLock" @handoff="send" @selection="selection = $event" />
      <div v-else class="empty-artifact artifact-panel"><h2>A place for your next idea</h2><p>Create a document, slide deck, or page above, or ask Claude to make one.</p></div>
    </section>
  </div>
</template>
