<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import Workspace from './Workspace.vue'
import DocumentEditor from './DocumentEditor.vue'
import PageEditor from './PageEditor.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import { api } from './api'
import { artifactReadSchema, artifactBatchSchema, upsertArtifactCard, normalizeArtifactCards, type Conversation, type OpenArtifact, type ArtifactKind, type ArtifactInfo, type WorkspaceMessage, type ArtifactAdapter, type ArtifactCommand } from '../shared/artifacts'
import type { ToolResult } from '../shared/model'
import type { CommentHandoff } from '../shared/comments'

const props = defineProps<{ conversation: Conversation }>()
const emit = defineEmits<{ refresh: []; lock: [locked: boolean] }>()
const artifacts = ref(props.conversation.artifacts), active = ref<OpenArtifact>(), adapter = ref<ArtifactAdapter>()
const messages = ref<WorkspaceMessage[]>([]), prompt = ref(''), error = ref(''), busy = ref(false), running = ref(false), childLocked = ref(false)
const aiConfigured = ref(false), selection = ref<unknown>(), chatScroll = ref<HTMLElement>()
const base = `/conversations/${props.conversation.id}`
const locked = computed(() => busy.value || running.value || childLocked.value)
let controller: AbortController | undefined, runId = '', followChat = true
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
    const parsed = command.name === 'read_context' ? artifactReadSchema.parse(command.input) : artifactBatchSchema.parse(command.input)
    if (!parsed.artifactId) throw new Error('Command is missing its artifact ID.')
    if (parsed.artifactId !== activeId.value) await open(parsed.artifactId, true)
    if (!adapter.value) throw new Error('Artifact editor is not ready.')
    if (command.name === 'read_context') {
      const { artifactId: _id, ...input } = artifactReadSchema.parse(parsed)
      if (active.value?.kind === 'slides' && !['deck', 'slide', 'selection'].includes(input.view)) throw new Error('Choose deck, slide or selection for a slide artifact.')
      if (active.value?.kind === 'document' && !['document', 'selection'].includes(input.view)) throw new Error('Choose document or selection for a text artifact.')
      if (active.value?.kind === 'page' && !['page', 'selection'].includes(input.view)) throw new Error('Choose page or selection for a page artifact.')
      return await adapter.value.execute({ ...command, name: 'read_context', input })
    }
    const { artifactId: _id, kind, ...input } = artifactBatchSchema.parse(parsed)
    if (active.value?.kind !== kind) throw new Error('Artifact kind mismatch.')
    return await adapter.value.execute({ ...command, name: 'apply_batch', input })
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}
async function scrollChat() { await nextTick(); if (followChat && chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight }
function trackScroll() { const el = chatScroll.value; if (el) followChat = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
async function send(handoff?: CommentHandoff) {
  const text = handoff?.message ?? prompt.value.trim()
  if (!text || locked.value || !aiConfigured.value) return
  try { await adapter.value?.flush() } catch (e) { error.value = String(e); return }
  running.value = true; emit('lock', true); error.value = ''; followChat = true
  if (!handoff) prompt.value = ''
  messages.value.push({ role: 'user', content: text }, { role: 'assistant', content: '', activities: [], artifacts: [] })
  const message = messages.value.at(-1)!
  controller = new AbortController()
  let completed = false
  try {
    const response = await fetch(`/api${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, artifactId: activeId.value, ...handoff }), signal: controller.signal })
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
        if (event === 'run') runId = data.id
        if (event === 'text') message.content += data.text
        if (event === 'error') throw new Error(data.error)
        if (event === 'done') completed = true
        if (event === 'artifact') { upsertArtifactCard(message.artifacts!, data); await refresh() }
        if (event === 'command') {
          message.activities!.push({ id: data.id, name: data.name, status: 'running' })
          const result = await execute(data)
          await api(`/workspace-runs/${runId}/commands/${data.id}`, { method: 'POST', body: JSON.stringify(result) })
        }
        if (event === 'tool_result') {
          const activity = { id: data.commandId, name: data.name, status: data.ok ? 'complete' as const : 'failed' as const, error: data.error, revision: data.data?.revision }
          const i = message.activities!.findIndex(a => a.id === activity.id)
          if (i < 0) message.activities!.push(activity); else message.activities![i] = activity
        }
        await scrollChat()
      }
      if (done) break
    }
    if (!completed) throw new Error('Chat stream ended before completion. Already saved changes are retained.')
  } catch (e) {
    error.value = controller.signal.aborted ? 'Cancelled. Already saved changes are retained.' : String(e)
    message.content += `\n${error.value}`
    if (runId) await api(`/workspace-runs/${runId}/cancel`, { method: 'POST' }).catch(cancelError => { error.value += ` Cancellation failed: ${cancelError}` })
  } finally {
    for (const a of message.activities ?? []) if (a.status === 'running') { a.status = 'interrupted'; a.error = 'Interrupted; inspect the saved artifact.' }
    running.value = false; controller = undefined; runId = ''; reportLock()
    await refresh().catch(e => { error.value = String(e) })
  }
}
async function cancel() {
  try { if (runId) await api(`/workspace-runs/${runId}/cancel`, { method: 'POST' }) }
  catch (e) { error.value = String(e) }
  controller?.abort()
}
function unload(e: BeforeUnloadEvent) { if (locked.value || prompt.value.trim()) { e.preventDefault(); e.returnValue = '' } }
onMounted(async () => {
  window.addEventListener('beforeunload', unload)
  busy.value = true; emit('lock', true)
  try {
    messages.value = (await api<WorkspaceMessage[]>(`${base}/messages`)).map(normalizeArtifactCards)
    aiConfigured.value = (await api<{ aiConfigured: boolean }>('/health')).aiConfigured
    const previous = localStorage.getItem(`pencil:active:${props.conversation.id}`)
    const first = artifacts.value.find(a => a.id === previous) ?? artifacts.value[0]
    if (first) await open(first.id, true)
    await scrollChat()
  } catch (e) { error.value = String(e) }
  finally { busy.value = false; reportLock() }
})
onUnmounted(() => { controller?.abort(); window.removeEventListener('beforeunload', unload) })
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
              <ul><li v-for="activity in message.activities" :key="activity.id"><div><strong>{{ activity.name }}: {{ activity.status }}</strong><small>{{ activity.error || (activity.revision !== undefined ? `Saved revision ${activity.revision}` : '') }}</small></div></li></ul>
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
        <details v-if="!aiConfigured" class="key-notice"><summary>Connect Claude to start a conversation</summary><p>Set ANTHROPIC_API_KEY in the server .env and restart. Editing, comments, and export work without a key.</p></details>
        <form class="composer" @submit.prevent="send()">
          <div v-if="selectionLabel" class="selection-context">{{ selectionLabel }}</div>
          <textarea aria-label="Message Claude" v-model="prompt" placeholder="What would you like to create or change?" :disabled="running" @keydown.ctrl.enter.prevent="send()" @keydown.meta.enter.prevent="send()" />
          <div class="composer-footer"><span class="model-label">Claude · Your creative partner</span><button v-if="running" type="button" @click="cancel">Stop</button><button v-else aria-label="Send message" :disabled="locked || !aiConfigured || !prompt.trim()">Send</button></div>
        </form>
        <p class="privacy-note">Artifacts stay local. AI receives context when you send.</p>
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
