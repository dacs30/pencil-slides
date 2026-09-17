<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Step } from '@tiptap/pm/transform'
import { closeHistory } from '@tiptap/pm/history'
import { documentExtensions, textSnapshotSchema, textBatchSchema, applyTextBatch, mapTextAnchor, safeLink, TitleStep } from '../shared/rich-text'
import type { TextDocument } from '../shared/artifacts'
import type { TextThread } from '../shared/text-comments'
import type { Command, ToolResult } from '../shared/model'
import type { CommentHandoff } from '../shared/comments'
import { api, ApiError } from './api'
import { saveWithReceipt, UnknownSaveOutcome } from './artifact-save'
import { DocumentSaveQueue } from './document-save'

const props = defineProps<{ document: TextDocument; saveBase: string; externalBusy: boolean; aiConfigured: boolean }>()
const emit = defineEmits<{ saved: []; lock: [locked: boolean]; handoff: [value: CommentHandoff]; selection: [value: unknown] }>()
const title = ref(props.document.snapshot.title), revision = ref(props.document.revision)
const error = ref(''), status = ref('Saved'), dirty = ref(false), saving = ref(false), fatal = ref(false), exporting = ref(false)
const generation = ref(0), selectedRange = ref({ from: 0, to: 0, text: '' })
const commentsOpen = ref(false), showResolved = ref(false), threads = ref<TextThread[]>([]), commentsLoaded = ref(false)
const commentError = ref(''), commentSaving = ref(false), focusedThread = ref('')
const draft = ref(''), draftRange = ref<{ from: number; to: number }>(), draftId = ref(crypto.randomUUID())
const replies = reactive<Record<string, string>>({}), replyIds = new Map<string, string>()
const linkOpen = ref(false), linkDraft = ref(''), commentInput = ref<HTMLTextAreaElement>()
const toolbar = ref<HTMLElement>(), surface = ref<HTMLElement>(), toolbarPosition = ref({ left: '0px', top: '0px' })
const locked = computed(() => props.externalBusy || fatal.value || exporting.value || commentSaving.value)
const hasDraft = computed(() => Boolean(draft.value || Object.values(replies).some(Boolean)))
const visibleThreads = computed(() => threads.value.filter(t => showResolved.value || !t.resolved))
const saves = new DocumentSaveQueue(props.document.snapshot, revision.value, (body, commandId) => saveWithReceipt(props.saveBase, body, commandId))
let editorTitle = title.value, saveTimer: ReturnType<typeof setTimeout> | undefined, unsavedSince = 0
let savePromise: Promise<void> | undefined, disposed = false, commentLoadId = 0

const guards = Extension.create({
  name: 'documentGuards',
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction(tr) {
        if (!tr.docChanged) return true
        try { textSnapshotSchema.parse({ version: 1, title: title.value.trim() || 'Untitled document', content: tr.doc.toJSON() }); return true }
        catch (e) { error.value = String(e); return false }
      },
      props: {
        decorations(state) {
          const decorations = threads.value.filter(t => !t.resolved && !t.anchor.detached && t.anchor.from < t.anchor.to && t.anchor.to <= state.doc.content.size)
            .map(t => Decoration.inline(t.anchor.from, t.anchor.to, { class: 'comment-highlight', 'data-thread-id': t.id }))
          return DecorationSet.create(state.doc, decorations)
        },
        handleClick(_view, _pos, event) {
          const id = (event.target as Element).closest('[data-thread-id]')?.getAttribute('data-thread-id')
          if (id) { commentsOpen.value = true; focusedThread.value = id }
          return false
        },
      },
    })]
  },
})
const editor = useEditor({
  extensions: [...documentExtensions, guards],
  editable: !props.externalBusy,
  content: props.document.snapshot.content,
  editorProps: { attributes: { 'aria-label': 'Document content', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' } },
  onTransaction({ transaction, editor: current }) {
    if (transaction.docChanged) {
      for (const step of transaction.steps) if (step instanceof TitleStep) { title.value = step.after; editorTitle = step.after }
      saves.append(transaction.steps.map(s => s.toJSON()))
      threads.value = threads.value.map(t => ({ ...t, anchor: mapTextAnchor(t.anchor, transaction.mapping.maps) }))
      if (draftRange.value) {
        const mapped = mapTextAnchor({ ...draftRange.value, quote: '', detached: false }, transaction.mapping.maps)
        if (mapped.detached) { draftRange.value = undefined; commentError.value = 'The draft selection was deleted. Select text again before posting.' }
        else draftRange.value = { from: mapped.from, to: mapped.to }
      }
      dirty.value = true; status.value = saving.value ? 'Saving...' : 'Unsaved changes'
      if (!unsavedSince) unsavedSince = Date.now()
      scheduleAutosave()
      void nextTick(updateDecorations)
    }
    const { from, to } = current.state.selection
    selectedRange.value = { from, to, text: current.state.doc.textBetween(from, to, '\n').slice(0, 2000) }
    generation.value++
    emit('selection', selectedRange.value)
    void nextTick(positionToolbar)
  },
})
watch(locked, value => editor.value?.setEditable(!value))
watch(title, updateDirty)
watch([locked, dirty, saving, hasDraft], () => emit('lock', locked.value || saving.value || dirty.value || hasDraft.value), { immediate: true })
const canUndo = computed(() => { generation.value; return editor.value?.can().undo() ?? false })
const canRedo = computed(() => { generation.value; return editor.value?.can().redo() ?? false })
function positionToolbar() {
  if (!editor.value || !toolbar.value || selectedRange.value.from === selectedRange.value.to) return
  const start = editor.value.view.coordsAtPos(selectedRange.value.from)
  const end = editor.value.view.coordsAtPos(selectedRange.value.to)
  const width = toolbar.value.offsetWidth, height = toolbar.value.offsetHeight
  const left = Math.max(8, Math.min((start.left + end.left - width) / 2, window.innerWidth - width - 8))
  const top = start.top - height - 10 >= 8 ? start.top - height - 10 : Math.min(end.bottom + 10, window.innerHeight - height - 8)
  toolbarPosition.value = { left: `${left}px`, top: `${Math.max(8, top)}px` }
}
function updateDecorations() { if (editor.value && !disposed) editor.value.view.dispatch(editor.value.state.tr.setMeta('comments', true)) }
async function loadComments() {
  const request = ++commentLoadId
  try {
    const data = await api<TextThread[]>(`${props.saveBase}/comments`)
    if (disposed || request !== commentLoadId) return
    const maps = saves.steps.map(s => Step.fromJSON(editor.value!.schema, s).getMap())
    threads.value = data.map(t => ({ ...t, anchor: mapTextAnchor(t.anchor, maps) }))
    commentsLoaded.value = true; commentError.value = ''; updateDecorations()
  } catch (e) { if (request === commentLoadId) commentError.value = String(e); throw e }
}
function updateDirty() { dirty.value = saves.steps.length > 0 || title.value !== editorTitle }
function scheduleAutosave() {
  clearTimeout(saveTimer)
  if (disposed || fatal.value) return
  const delay = Math.min(1500, Math.max(0, 10000 - (Date.now() - unsavedSince)))
  saveTimer = setTimeout(autosave, delay)
}
function autosave() {
  if (disposed || fatal.value || !saves.steps.length) return
  if (editor.value?.view.composing || locked.value || savePromise) {
    saveTimer = setTimeout(autosave, 500)
    return
  }
  void savePending().catch(() => { /* savePending displays the error and retains unsaved transactions. */ })
}
async function savePending() {
  if (savePromise) return savePromise
  if (fatal.value) throw new Error('Reload required before continuing.')
  if (!editor.value || !saves.steps.length) return
  clearTimeout(saveTimer)
  commentLoadId++
  saving.value = true
  savePromise = (async () => {
    try {
      const snapshot = textSnapshotSchema.parse({ version: 1, title: editorTitle, content: editor.value!.getJSON() })
      status.value = 'Saving...'
      await saves.save(snapshot)
      revision.value = saves.revision
      updateDirty()
      unsavedSince = saves.steps.length ? Date.now() : 0
      status.value = dirty.value ? 'Unsaved changes' : 'Saved'; error.value = ''; emit('saved')
      await loadComments().catch(() => { /* Separate comments error is visible. */ })
      if (saves.steps.length) scheduleAutosave()
    } catch (e) {
      if (e instanceof UnknownSaveOutcome || (e instanceof ApiError && e.status === 409)) fatal.value = true
      error.value = String(e); status.value = fatal.value ? 'Reload required' : 'Save failed'; throw e
    } finally { saving.value = false }
  })()
  try { await savePromise } finally { savePromise = undefined }
}
async function flush() {
  clearTimeout(saveTimer)
  if (fatal.value) throw new Error('Reload required before continuing.')
  if (savePromise) await savePromise
  while (saves.steps.length) await savePending()
  clearTimeout(saveTimer)
}
function rename() {
  if (!editor.value) return
  const name = title.value.trim()
  if (!name || name.length > 200) { title.value = editorTitle; error.value = 'Document title must be 1-200 characters.'; return }
  editor.value.view.dispatch(closeHistory(editor.value.state.tr).step(new TitleStep(editorTitle, name)))
  editor.value.view.dispatch(closeHistory(editor.value.state.tr))
  void flush().catch(() => { /* Visible save error. */ })
}
async function execute(command: Command): Promise<ToolResult> {
  if (!editor.value) return { ok: false, error: 'Document editor is not ready.' }
  if (fatal.value) return { ok: false, error: 'Reload required before reading or editing this document.' }
  try {
    if (command.name === 'read_context') {
      return { ok: true, data: {
        kind: 'document', artifactId: props.document.id, revision: revision.value, title: title.value,
        selection: selectedRange.value, content: editor.value.getJSON(), contentSize: editor.value.state.doc.content.size,
      } }
    }
    const input = textBatchSchema.parse(command.input)
    if (fatal.value || savePromise || input.expectedRevision !== revision.value || saves.steps.length) throw new Error('Read current saved document context before editing.')
    const before = editor.value.state, beforeTitle = title.value, beforeThreads = structuredClone(threads.value.map(t => JSON.parse(JSON.stringify(t)) as TextThread))
    const result = applyTextBatch({ version: 1, title: title.value, content: editor.value.getJSON() }, input.operations)
    saving.value = true; editor.value.setEditable(false); status.value = 'Saving...'
    try {
      let tr = closeHistory(editor.value.state.tr)
      for (const step of result.steps) tr = tr.step(Step.fromJSON(editor.value.schema, step))
      title.value = result.snapshot.title
      editor.value.view.dispatch(tr)
      clearTimeout(saveTimer)
      const body = JSON.stringify({ expectedRevision: revision.value, commandId: command.id, snapshot: result.snapshot, steps: result.steps })
      const saved = await saveWithReceipt(props.saveBase, body, command.id)
      saves.reset(result.snapshot, saved.revision)
      revision.value = saved.revision; unsavedSince = 0; dirty.value = false; status.value = 'Saved'; error.value = ''
      editor.value.view.dispatch(closeHistory(editor.value.state.tr))
      emit('saved')
      await loadComments().catch(() => { /* Comments error is separate from durable document success. */ })
      return { ok: true, data: { revision: revision.value } }
    } catch (e) {
      if (e instanceof UnknownSaveOutcome || (e instanceof ApiError && e.status === 409)) fatal.value = true
      if (!fatal.value) {
        editor.value.view.updateState(before); title.value = beforeTitle; editorTitle = beforeTitle; threads.value = beforeThreads
        saves.reset({ version: 1, title: beforeTitle, content: before.doc.toJSON() }, revision.value)
        unsavedSince = 0; dirty.value = false
      }
      error.value = String(e); status.value = fatal.value ? 'Reload required' : 'Change failed'; throw e
    } finally { saving.value = false; editor.value.setEditable(!locked.value) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}
function heading(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  if (value === 1 || value === 2 || value === 3) editor.value?.chain().focus().setHeading({ level: value }).run()
  else editor.value?.chain().focus().setParagraph().run()
}
function openLink() { linkDraft.value = editor.value?.getAttributes('link').href ?? ''; linkOpen.value = true }
function saveLink() {
  if (locked.value) return
  if (linkDraft.value && !safeLink(linkDraft.value)) { error.value = 'Use a complete http, https or mailto link.'; return }
  if (linkDraft.value) editor.value?.chain().focus().setLink({ href: linkDraft.value }).run()
  else editor.value?.chain().focus().unsetLink().run()
  linkOpen.value = false
}
async function startComment() {
  if (!selectedRange.value.text.trim() || !commentsLoaded.value || locked.value) return
  draftRange.value = { from: selectedRange.value.from, to: selectedRange.value.to }
  commentsOpen.value = true
  await nextTick(); commentInput.value?.focus()
}
async function postComment() {
  if (!draftRange.value || !draft.value.trim() || locked.value) return
  commentSaving.value = true
  try {
    await flush()
    await api(`${props.saveBase}/comments`, { method: 'POST', body: JSON.stringify({ id: draftId.value, expectedRevision: revision.value, ...draftRange.value, body: draft.value.trim() }) })
    draft.value = ''; draftRange.value = undefined; draftId.value = crypto.randomUUID()
    await loadComments()
  } catch (e) { commentError.value = String(e) }
  finally { commentSaving.value = false }
}
async function updateThread(thread: TextThread, reply: boolean) {
  if (locked.value) return
  commentSaving.value = true
  try {
    await flush()
    const current = threads.value.find(t => t.id === thread.id)!
    if (reply && !replyIds.has(thread.id)) replyIds.set(thread.id, crypto.randomUUID())
    const body = reply
      ? { id: replyIds.get(thread.id), expectedVersion: current.version, body: replies[thread.id]?.trim() }
      : { expectedVersion: current.version, resolved: !current.resolved }
    await api(`${props.saveBase}/comments/${thread.id}${reply ? '/replies' : ''}`, { method: reply ? 'POST' : 'PATCH', body: JSON.stringify(body) })
    if (reply) { replies[thread.id] = ''; replyIds.delete(thread.id) }
    await loadComments()
  } catch (e) { commentError.value = String(e) }
  finally { commentSaving.value = false }
}
function selectThread(thread: TextThread) {
  focusedThread.value = thread.id
  if (!thread.anchor.detached && !locked.value) editor.value?.chain().focus().setTextSelection({ from: thread.anchor.from, to: thread.anchor.to }).scrollIntoView().run()
}
async function handoff(thread: TextThread) {
  if (locked.value) return
  try {
    await flush()
    const current = threads.value.find(t => t.id === thread.id)!
    if (!current.anchor.detached) editor.value?.commands.setTextSelection({ from: current.anchor.from, to: current.anchor.to })
    emit('handoff', { commentThreadId: thread.id, expectedCommentVersion: current.version, message: `Please address this comment in "${title.value}".` })
  } catch (e) { commentError.value = String(e) }
}
async function downloadWord() {
  if (locked.value) return
  exporting.value = true
  try {
    await flush()
    const { exportWord } = await import('./word-export')
    const bytes = await exportWord({ version: 1, title: title.value, content: editor.value!.getJSON() })
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
    const a = document.createElement('a'); a.href = url; a.download = `${title.value.replace(/[^\p{L}\p{N} _-]/gu, '_').slice(0, 120) || 'Document'}.docx`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    status.value = 'Word exported'
  } catch (e) { error.value = `Word export failed: ${e instanceof Error ? e.message : e}` }
  finally { exporting.value = false }
}
function beforeUnload(e: BeforeUnloadEvent) { if (dirty.value || saving.value || locked.value || hasDraft.value) { e.preventDefault(); e.returnValue = '' } }
function reloadPage() { window.location.reload() }
function cancelComment() { draft.value = ''; draftRange.value = undefined; draftId.value = crypto.randomUUID() }
onMounted(() => {
  void loadComments().catch(() => { /* Visible comments error. */ })
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('resize', positionToolbar)
  window.addEventListener('scroll', positionToolbar, true)
})
onUnmounted(() => {
  disposed = true; clearTimeout(saveTimer); editor.value?.destroy()
  window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('resize', positionToolbar); window.removeEventListener('scroll', positionToolbar, true)
})
defineExpose({ flush, execute, context: () => selectedRange.value })
</script>

<template>
  <main class="artifact-panel document-artifact" aria-label="Document artifact" ref="surface">
    <header class="artifact-heading">
      <div class="artifact-heading-icon" aria-hidden="true">T</div>
      <div class="artifact-title"><span class="eyebrow">DOCUMENT</span><input aria-label="Document title" class="deck-title" v-model="title" :disabled="locked" @change="rename"></div>
      <span class="save-state" role="status">{{ status }} <small>r{{ revision }}</small></span>
    </header>
    <div v-if="error" class="error" role="alert">{{ error }}<button v-if="fatal" @click="reloadPage">Reload</button><button v-else :disabled="locked" @click="flush().catch(() => {})">Retry save</button></div>
    <div class="toolbar document-toolbar" role="toolbar" aria-label="Document actions">
      <select aria-label="Paragraph style" :disabled="locked" :value="editor?.isActive('heading') ? editor.getAttributes('heading').level : 0" @change="heading">
        <option :value="0">Text</option><option :value="1">Heading 1</option><option :value="2">Heading 2</option><option :value="3">Heading 3</option>
      </select>
      <button :disabled="locked" :aria-pressed="editor?.isActive('bulletList')" @click="editor?.chain().focus().toggleBulletList().run()">Bullet list</button>
      <button :disabled="locked" :aria-pressed="editor?.isActive('orderedList')" @click="editor?.chain().focus().toggleOrderedList().run()">Numbered list</button>
      <button aria-label="Undo" :disabled="locked || !canUndo" @click="editor?.chain().focus().undo().run()">Undo</button>
      <button aria-label="Redo" :disabled="locked || !canRedo" @click="editor?.chain().focus().redo().run()">Redo</button>
      <button :aria-expanded="commentsOpen" @click="commentsOpen = !commentsOpen">Comments {{ threads.filter(t => !t.resolved).length || '' }}</button>
      <button :disabled="locked" @click="downloadWord">{{ exporting ? 'Exporting...' : 'Export Word' }}</button>
    </div>
    <div class="document-body">
      <div class="document-scroll"><EditorContent :editor="editor" class="document-page" /></div>
      <aside v-if="commentsOpen" class="document-comments" aria-label="Document comments">
        <div class="panel-heading">Comments<button aria-label="Close comments" @click="commentsOpen = false">X</button></div>
        <div v-if="commentError" class="error" role="alert">{{ commentError }}<button :disabled="locked || saving" @click="loadComments().catch(() => {})">Refresh comments</button></div>
        <label><input type="checkbox" v-model="showResolved"> Show resolved</label>
        <p v-if="!draftRange" class="hint">Select text, then choose Comment in the floating toolbar.</p>
        <form v-if="draftRange || draft" class="document-comment-form" @submit.prevent="postComment">
          <label>New comment<textarea ref="commentInput" aria-label="New document comment" v-model="draft" maxlength="2000" :disabled="locked" /></label>
          <button :disabled="locked || !draftRange || !draft.trim()">Post comment</button>
          <button type="button" :disabled="locked" @click="cancelComment">Cancel</button>
        </form>
        <article v-for="thread in visibleThreads" :key="thread.id" class="document-thread" :class="{ focused: focusedThread === thread.id }">
          <button class="thread-quote" :disabled="locked" @click="selectThread(thread)">{{ thread.anchor.quote }}</button>
          <small v-if="thread.anchor.detached">Detached: original text was removed.</small>
          <p v-for="message in thread.messages" :key="message.id"><strong>You</strong><br>{{ message.body }}</p>
          <button :disabled="locked" @click="updateThread(thread, false)">{{ thread.resolved ? 'Reopen' : 'Resolve' }}</button>
          <button v-if="!thread.resolved" :disabled="locked || !aiConfigured" @click="handoff(thread)">Ask Claude to address this</button>
          <form v-if="!thread.resolved" @submit.prevent="updateThread(thread, true)">
            <textarea :aria-label="`Reply to ${thread.anchor.quote}`" v-model="replies[thread.id]" maxlength="2000" :disabled="locked" />
            <button :disabled="locked || !replies[thread.id]?.trim()">Reply</button>
          </form>
        </article>
      </aside>
    </div>
    <footer class="document-footer">Editable document · Word export uses US Letter; fonts and page breaks may differ in Word.</footer>
    <div v-if="editor && selectedRange.text && !locked && !draftRange" ref="toolbar" class="document-selection-toolbar" role="toolbar" aria-label="Text formatting" :style="toolbarPosition" @mousedown.prevent>
      <button :aria-pressed="editor.isActive('bold')" @click="editor.chain().focus().toggleBold().run()"><b>Bold</b></button>
      <button :aria-pressed="editor.isActive('italic')" @click="editor.chain().focus().toggleItalic().run()"><i>Italic</i></button>
      <button :aria-pressed="editor.isActive('underline')" @click="editor.chain().focus().toggleUnderline().run()"><u>Underline</u></button>
      <button :aria-pressed="editor.isActive('strike')" @click="editor.chain().focus().toggleStrike().run()">Strike</button>
      <button :aria-pressed="editor.isActive('highlight')" @click="editor.chain().focus().toggleHighlight().run()">Highlight</button>
      <button :aria-pressed="editor.isActive('code')" @click="editor.chain().focus().toggleCode().run()">Code</button>
      <button @click="openLink">Link</button>
      <button :disabled="!commentsLoaded" @click="startComment">Comment</button>
    </div>
    <form v-if="linkOpen" class="document-link-form" @submit.prevent="saveLink">
      <label>Link URL<input aria-label="Link URL" v-model="linkDraft" placeholder="https://example.com" :disabled="locked"></label>
      <button :disabled="locked">Apply link</button><button type="button" @click="linkOpen = false">Cancel</button>
    </form>
  </main>
</template>
