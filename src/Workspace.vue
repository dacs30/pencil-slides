<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { createDefaultEditorState, createEditor } from '@open-pencil/core/editor'
import { SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import { provideEditor } from '@open-pencil/vue'
import { renderNodesToImage } from '@open-pencil/core/io/formats/raster'
import { api, ApiError } from './api'
import { applyOperations, restore, snapshot } from './document'
import { batchSchema, operationSchema, readSchema, type Command, type Deck, type ElementProperties, type Operation, type Snapshot, type ToolResult } from '../shared/model'
import CanvasPane from './CanvasPane.vue'
import ArtifactCard from './ArtifactCard.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import type { ChatMessage, SlideArtifact, ToolActivity } from '../shared/chat'
import type { PowerPointMode, SlideExportReport } from './pptx-export'
import { useComments } from './useComments'
import CommentsSidebar from './CommentsSidebar.vue'
import CommentOverlay from './CommentOverlay.vue'
import CanvasContextMenu from './CanvasContextMenu.vue'
import SelectionToolbar from './SelectionToolbar.vue'
import { toolbarSelection } from './selection-toolbar'
import type { CommentHandoff } from '../shared/comments'
import { saveWithReceipt, UnknownSaveOutcome } from './artifact-save'
import { prepareBrowserChat, committedBrowserResult, MessageWriter } from './browser-chat'
import { browserStore } from './local-store'
import { artifactReadSchema, artifactBatchSchema, type ArtifactCommand } from '../shared/artifacts'

const props = defineProps<{ deck: Deck; embedded?: boolean; externalBusy?: boolean; saveBase?: string }>()
const emit = defineEmits<{ saved: []; lock: [locked: boolean]; handoff: [request: CommentHandoff]; selection: [context: unknown] }>()
const graph = new SceneGraph()
restore(graph, props.deck.snapshot)
const meta = reactive({ title: props.deck.snapshot.title, pageId: props.deck.snapshot.pageId, slides: props.deck.snapshot.slides.map(s => ({ ...s })) })
const viewport = ref<HTMLElement>()
const state = reactive(createDefaultEditorState(meta.pageId))
const editor = createEditor({ graph, state, getViewportSize: () => ({ width: viewport.value?.clientWidth ?? 1000, height: viewport.value?.clientHeight ?? 700 }) })
provideEditor(editor)
const active = ref(meta.slides[0]!.id)
const revision = ref(props.deck.revision)
const ready = ref(false)
const contextMenuOpen = ref(false)
const canvasInteracting = ref(false)
const saving = ref(false)
const exportingPptx = ref(false)
const exportMessage = ref('')
const exportReport = ref<SlideExportReport[]>([])
const exportFonts = ref<string[]>([])
const dirty = ref(false)
const running = ref(false)
const fatal = ref(false)
const error = ref('')
const status = ref('Saved')
const generation = ref(0)
const thumbnails = reactive<Record<string, string>>({})
const presenting = ref(false)
const presentImage = ref('')
const selected = computed(() => { generation.value; state.sceneVersion; return graph.getNode([...state.selectedIds][0] ?? '') })
const activeSlide = computed(() => meta.slides.find(s => s.id === active.value) ?? meta.slides[0]!)
const layers = computed(() => { generation.value; return graph.getChildren(activeSlide.value.id) })
const toolbarNode = computed(() => { generation.value; state.sceneVersion; return toolbarSelection(graph, state.selectedIds, active.value) })
const artworkBusy = computed(() => Boolean(props.externalBusy || running.value || saving.value || fatal.value || presenting.value || exportingPptx.value))
const commentState = useComments({ deckId: props.deck.id, editor, active, revision, generation, artworkBusy, flush, navigate, handoff: async request => { if (props.embedded) emit('handoff', request); else await sendChat(request) } })
const comments = reactive(commentState)
const locked = computed(() => artworkBusy.value || comments.saving || comments.pointMode)
const titleInput = ref(meta.title)
const prompt = ref('')
const messages = ref<ChatMessage[]>([])
const propertiesOpen = ref(false)
const thumbnailsOpen = ref(true)
const chatScroll = ref<HTMLElement>()
const composer = ref<HTMLTextAreaElement>()
const artifactPanel = ref<HTMLElement>()
const activeIndex = computed(() => meta.slides.findIndex(s => s.id === active.value))
const currentArtifact = computed<SlideArtifact>(() => ({ title: meta.title, revision: revision.value, slideIds: meta.slides.map(s => s.id) }))
const canUndo = computed(() => { generation.value; return editor.undo.canUndo })
const canRedo = computed(() => { generation.value; return editor.undo.canRedo })
let followChat = true
let viewportObserver: ResizeObserver | undefined
let resizeFrame = 0
const toolStatus = ref('')
const aiConfigured = ref(false)
let runId = ''
let runToken = ''
let chatController: AbortController | undefined
let stopped = false
let suppressed = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
let thumbnailTimer: ReturnType<typeof setTimeout> | undefined
let savePromise: Promise<void> | undefined
let lastSaved = JSON.stringify(props.deck.snapshot)
watch([locked, dirty, commentState.hasDraft], () => emit('lock', locked.value || dirty.value || comments.hasDraft), { immediate: true })
watch(propertiesOpen, value => { if (value) comments.open = false })
watch(commentState.open, value => { if (value) propertiesOpen.value = false })
watch(() => [state.sceneVersion, [...state.selectedIds].join('\0'), active.value], () => emit('selection', { selectedIds: [...state.selectedIds], name: selected.value?.name }), { immediate: true })
watch(() => [messages.value.length, messages.value.at(-1)?.content, messages.value.at(-1)?.activities?.length, messages.value.at(-1)?.artifacts?.length], async () => {
  await nextTick()
  if (messages.value.length && followChat && chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight
})

function trackChatScroll() {
  const el = chatScroll.value
  if (el) followChat = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
function suggest(text: string) { prompt.value = text; composer.value?.focus() }
function openArtifact(artifact: SlideArtifact) {
  const target = artifact.slideIds.find(id => meta.slides.some(s => s.id === id)) ?? active.value
  navigate(target)
  artifactPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}
function stepSlide(delta: number) {
  const slide = meta.slides[activeIndex.value + delta]
  if (slide) navigate(slide.id)
}
function zoom(delta: number) {
  editor.setZoomAroundPoint(Math.max(0.05, Math.min(3, state.zoom * delta)), (viewport.value?.clientWidth ?? 0) / 2, (viewport.value?.clientHeight ?? 0) / 2)
}
async function insertShape(type: 'RECTANGLE' | 'ELLIPSE', event: Event) {
  const menu = (event.target as Element).closest('details')
  if (menu) menu.open = false
  await addElement(type)
}
function toolName(activity: ToolActivity) {
  return activity.name === 'read_context' ? 'Read editor context' : activity.name === 'apply_batch' ? 'Apply slide changes' : activity.name
}
function activitySummary(activities: ToolActivity[]) {
  if (activities.some(a => a.status === 'running')) return 'Working with your slides'
  const completed = activities.filter(a => a.status === 'complete').length
  return `${completed} of ${activities.length} editor actions completed`
}

function capture() { return snapshot(graph, meta) }
function restoreAll(data: Snapshot) {
  restore(graph, data)
  meta.title = data.title; meta.slides = structuredClone(data.slides)
  titleInput.value = data.title
  if (!meta.slides.some(s => s.id === active.value)) active.value = meta.slides[0]!.id
  editor.clearSelection()
  editor.renderer?.invalidateAllPictures()
  editor.requestRender()
  generation.value++
}
function fit(id = active.value) {
  const n = graph.getNode(id)
  if (!n) return
  active.value = id
  // zoomToBounds already includes 80 units of SDK padding on each edge.
  editor.zoomToBounds(n.x, n.y, n.x + 1920, n.y + 1080)
}
function navigate(id: string) {
  if (locked.value) return
  editor.clearSelection()
  fit(id)
}
function changed() {
  if (suppressed || stopped) return
  generation.value++
  dirty.value = true
  status.value = 'Unsaved changes'
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flush().catch(() => {}) }, 500)
}
const offHistory = editor.onEditorEvent('history:changed', changed)
// Native text edits and pointer commits use SDK history. Node events also cover text/layout updates.
const offNodes = graph.onNodeEvents({
  updated: (_id, changes) => {
    if (suppressed) return
    generation.value++
    if (state.editingTextId && ('text' in changes || 'styleRuns' in changes)) {
      dirty.value = true
      status.value = 'Editing text…'
    }
  },
  previewUpdated: () => { generation.value++ },
  reparented: (id, oldParent, newParent) => {
    if (suppressed || meta.slides.some(s => s.id === id || s.id === newParent)) return
    const parent = meta.slides.find(s => s.id === oldParent)?.id ?? active.value
    graph.reparentNode(id, parent)
  },
})
const offSelection = editor.onEditorEvent('selection:changed', ids => {
  // Slide frames are fixed-size artboards, not draggable/resizable content.
  const elements = ids.filter(id => !meta.slides.some(s => s.id === id))
  if (elements.length !== ids.length) editor.select(elements)
})
function scheduleThumbnails() {
  clearTimeout(thumbnailTimer)
  thumbnailTimer = setTimeout(() => { void refreshThumbnails().catch(e => { error.value = String(e) }) }, 600)
}
async function durableSave(data: Snapshot, commandId: string) {
  const body = JSON.stringify({ expectedRevision: revision.value, snapshot: data, commandId })
  try {
    const saved = await saveWithReceipt(props.saveBase ?? `/decks/${props.deck.id}`, body, commandId)
    revision.value = saved.revision
    lastSaved = JSON.stringify(data)
    void comments.reload()
  } catch (e) {
    if (e instanceof UnknownSaveOutcome) fatal.value = true
    throw e
  }
}
async function flush() {
  if (state.editingTextId) editor.commitTextEdit()
  clearTimeout(saveTimer)
  if (savePromise) return savePromise
  if (suppressed || fatal.value) return
  savePromise = (async () => {
    try {
      const data = capture()
      if (JSON.stringify(data) === lastSaved) { dirty.value = false; status.value = 'Saved'; return }
      saving.value = true
      status.value = 'Saving…'
      await durableSave(data, crypto.randomUUID())
      dirty.value = false; status.value = 'Saved'; error.value = ''
      emit('saved'); scheduleThumbnails()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) fatal.value = true
      error.value = String(e); status.value = fatal.value ? 'Reload required' : 'Save failed'; throw e
    }
    finally { saving.value = false }
  })()
  try { await savePromise } finally { savePromise = undefined }
}
async function batch(operations: Operation[], commandId: string = crypto.randomUUID(), expected = revision.value) {
  if (fatal.value) throw new Error('Editor needs reload')
  if (expected !== revision.value) throw new Error(`Revision conflict: expected ${expected}, actual ${revision.value}. Read context again.`)
  const before = capture()
  const beforeSelection = [...state.selectedIds]
  suppressed = true
  saving.value = true
  clearTimeout(saveTimer)
  status.value = 'Saving…'
  try {
    applyOperations(editor, meta, operations.map(o => operationSchema.parse(o)))
    const after = capture()
    await durableSave(after, commandId)
    editor.pushUndoEntry({ label: 'Edit slides', forward: () => restoreAll(after), inverse: () => restoreAll(before) })
    dirty.value = false; status.value = 'Saved'; error.value = ''
    if (!meta.slides.some(s => s.id === active.value)) active.value = meta.slides[0]!.id
    generation.value++
    emit('saved'); scheduleThumbnails()
    return { revision: revision.value }
  } catch (e) {
    if (!fatal.value) { restoreAll(before); editor.select(beforeSelection.filter(id => graph.getNode(id))) }
    if (e instanceof ApiError && e.status === 409) fatal.value = true
    error.value = String(e); status.value = fatal.value ? 'Reload required' : 'Change failed'
    throw e
  } finally { suppressed = false; saving.value = false }
}
async function manual(operations: Operation[]) {
  if (locked.value) return
  try { await flush(); await batch(operations) } catch (e) { error.value = String(e) }
}
async function addSlide() {
  const id = crypto.randomUUID()
  await manual([{ op: 'create_slide', id, title: `Slide ${meta.slides.length + 1}` }])
  if (graph.getNode(id)) fit(id)
}
async function addElement(type: 'TEXT' | 'RECTANGLE' | 'ELLIPSE') {
  const id = crypto.randomUUID()
  await manual([{ op: 'create_element', id, slideId: active.value, type, props: type === 'TEXT' ? { text: 'Your text here', y: 300 } : { width: 400, height: 240, y: 500 } }])
  if (graph.getNode(id)) editor.select([id])
}
function updateProperty(key: string, event: Event) {
  if (!selected.value) return
  const value = (event.target as HTMLInputElement).value
  const p = { [key]: ['x', 'y', 'width', 'height', 'fontSize', 'rotation'].includes(key) ? Number(value) : value }
  void manual([{ op: 'update_element', id: selected.value.id, props: p }])
}
async function formatSelection(id: string, changes: ElementProperties) {
  if (running.value || fatal.value || presenting.value || exportingPptx.value || comments.saving || comments.pointMode || contextMenuOpen.value || canvasInteracting.value || state.editingTextId || toolbarNode.value?.id !== id) return
  if (saving.value) { try { await flush() } catch { return } }
  if (locked.value || !graph.getNode(id)) return
  await manual([{ op: 'update_element', id, props: changes }])
}
async function selectionProperties(id: string) {
  if (locked.value || toolbarNode.value?.id !== id) return
  propertiesOpen.value = true
  await nextTick()
  artifactPanel.value?.querySelector<HTMLInputElement>('.property-fields input')?.focus()
}
function selectionComment(id: string) {
  if (locked.value || toolbarNode.value?.id !== id) return
  void comments.startAt({ kind: 'object', slideId: active.value, nodeId: id })
}
function dismissSelectionToolbar() {
  editor.clearSelection()
  void nextTick(() => viewport.value?.querySelector('canvas')?.focus())
}
function reorder(delta: number) {
  const ids = meta.slides.map(s => s.id)
  const i = ids.indexOf(active.value), j = i + delta
  if (j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
  void manual([{ op: 'reorder_slides', ids }]).then(() => fit())
}
async function renameDeck() {
  if (!titleInput.value.trim() || locked.value) { titleInput.value = meta.title; return }
  const before = capture()
  meta.title = titleInput.value.trim().slice(0, 200)
  const after = capture()
  editor.pushUndoEntry({ label: 'Rename deck', forward: () => restoreAll(after), inverse: () => restoreAll(before) })
  try { await flush() } catch { /* Error is visible; preserve unsaved edits. */ }
}
function nodeSummary(n: SceneNode) {
  return { id: n.id, type: n.type, name: n.name, slideId: n.parentId, x: n.x, y: n.y, width: n.width, height: n.height, text: n.text, fontSize: n.fontSize, fontWeight: n.fontWeight, rotation: n.rotation, fills: n.fills }
}
function hexFill(n: SceneNode | undefined) {
  const color = n?.fills[0]?.color
  if (!color) return '#ffffff'
  return '#' + [color.r, color.g, color.b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')
}
async function execute(command: Command): Promise<ToolResult> {
  try {
    if (command.name === 'read_context') {
      const input = readSchema.parse(command.input)
      const slideId = input.slideId ?? active.value
      if (input.view === 'slide' && !meta.slides.some(s => s.id === slideId)) throw new Error('Slide does not exist')
      const nodes = input.view === 'selection' ? [...state.selectedIds].map(id => graph.getNode(id)!).filter(Boolean)
        : input.view === 'slide' ? graph.getChildren(slideId) : []
      return { ok: true, data: {
        revision: revision.value, title: meta.title, activeSlideId: active.value,
        selectedIds: [...state.selectedIds],
        slides: meta.slides.map(s => ({ ...s, background: hexFill(graph.getNode(s.id)) })),
        nodes: nodes.map(nodeSummary),
      } }
    }
    const input = batchSchema.parse(command.input)
    return { ok: true, data: await batch(input.operations, command.id, input.expectedRevision) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}
async function sendChat(handoff?: CommentHandoff) {
  const message = handoff?.message ?? prompt.value.trim()
  if (!message || locked.value) return
  try { await flush() } catch { return }
  let conversationId: string, request: Awaited<ReturnType<typeof prepareBrowserChat>>
  try {
    conversationId = await browserStore.owner(props.deck.id)
    request = await prepareBrowserChat(conversationId, message, props.deck.id, messages.value.map(m => ({ role: m.role, content: m.content })), handoff)
  } catch (e) { error.value = String(e); return }
  running.value = true
  error.value = ''; toolStatus.value = ''; runId = ''; runToken = ''
  if (!handoff) prompt.value = ''
  followChat = true
  messages.value.push({ role: 'user', content: message }, { role: 'assistant', content: '', runState: 'running', activities: [], artifacts: [] })
  const responseMessage = messages.value[messages.value.length - 1]!
  chatController = new AbortController()
  const messageId = crypto.randomUUID()
  const writer = new MessageWriter(conversationId, messageId, () => ({
    role: 'assistant', content: responseMessage.content, runState: responseMessage.runState, activities: responseMessage.activities,
    artifacts: responseMessage.artifacts?.map(a => ({ id: props.deck.id, kind: 'slides', title: a.title, revision: a.revision })),
  }), failure => { error.value = `Chat could not be saved in this browser: ${String(failure)}`; chatController?.abort(new Error(error.value)) })
  let completed = false
  async function standaloneCommand(command: ArtifactCommand): Promise<ToolResult> {
    try {
      if (command.name === 'create_artifact') throw new Error('Create other artifacts from the shared conversation workspace.')
      if (command.name === 'read_context') {
        const input = artifactReadSchema.parse(command.input)
        if (input.view === 'workspace') return { ok: true, data: { id: conversationId, artifacts: [{ id: props.deck.id, kind: 'slides', title: meta.title, revision: revision.value }], activeArtifactId: props.deck.id } }
        if (input.artifactId !== props.deck.id) throw new Error('This standalone editor only handles its current deck.')
        const result = await execute({ ...command, name: 'read_context', input: { view: input.view, ...(input.slideId ? { slideId: input.slideId } : {}) } })
        if (!result.ok) return result
        if (!result.data || typeof result.data !== 'object') throw new Error('Invalid editor context.')
        return { ok: true, data: { ...result.data, artifactId: props.deck.id, kind: 'slides' } }
      }
      const input = artifactBatchSchema.parse(command.input)
      if (input.kind !== 'slides' || input.artifactId !== props.deck.id) throw new Error('This standalone editor only handles its current deck.')
      return committedBrowserResult(conversationId, props.deck.id, command.id, await execute({ ...command, name: 'apply_batch', input: { expectedRevision: input.expectedRevision, operations: input.operations } }))
    } catch (e) { return { ok: false, error: String(e).slice(0, 5000) } }
  }
  try {
    await browserStore.putMessage(conversationId, crypto.randomUUID(), { role: 'user', content: message })
    writer.changed(); await writer.flush()
    const response = await fetch(`/api/conversations/${conversationId}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: chatController.signal })
    if (!response.ok) throw new Error((await response.json()).error || 'Chat failed')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const event = packet.match(/^event: (.+)$/m)?.[1]
        const raw = packet.match(/^data: (.+)$/m)?.[1]
        if (!event || !raw) continue
        const data = JSON.parse(raw)
        if (event === 'run') { runId = data.id; runToken = data.token }
        if (event === 'text') responseMessage.content += data.text
        if (event === 'error') throw new Error(data.error)
        if (event === 'done') completed = true
        if (event === 'artifact') {
          if (data.id !== props.deck.id || data.kind !== 'slides') throw new Error('Received an artifact for another editor.')
          const card = { title: data.title, revision: data.revision, slideIds: meta.slides.map(s => s.id) }
          if (responseMessage.artifacts!.length) responseMessage.artifacts![0] = card
          else responseMessage.artifacts!.push(card)
        }
        if (event === 'tool_result') {
          toolStatus.value = data.ok ? 'Editor action completed' : 'Editor action returned an error'
          const activity: ToolActivity = { id: data.commandId, name: data.name, status: data.ok ? 'complete' : 'failed', error: data.error, revision: data.name === 'apply_batch' && data.ok ? data.data?.revision : undefined }
          const index = responseMessage.activities!.findIndex(a => a.id === data.commandId)
          if (index === -1) responseMessage.activities!.push(activity)
          else responseMessage.activities![index] = activity
        }
        if (event === 'command') {
          toolStatus.value = data.name === 'read_context' ? 'Reading editor context…' : 'Updating your slides…'
          responseMessage.activities!.push({ id: data.id, name: data.name, status: 'running' })
          if (!chatController.signal.aborted) {
            const result = await standaloneCommand(data)
            await api(`/workspace-runs/${runId}/commands/${data.id}`, { method: 'POST', headers: { Authorization: `Bearer ${runToken}` }, body: JSON.stringify(result) })
          }
        }
        writer.changed()
        if (event === 'tool_result' || event === 'artifact') await writer.flush()
      }
      if (done) break
    }
    if (!completed) throw new Error('Chat stream ended before completion. Browser-saved changes are retained.')
  } catch (e) {
    const message = chatController.signal.aborted ? chatController.signal.reason instanceof Error && chatController.signal.reason.name !== 'AbortError' ? chatController.signal.reason.message : 'Cancelled. Browser-saved changes are retained.' : String(e)
    error.value = message
    responseMessage.content += `\n${message}`
    if (runId && runToken) await api(`/workspace-runs/${runId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${runToken}` } }).catch(cancelError => { error.value += ` Cancellation failed: ${String(cancelError)}` })
  } finally {
    responseMessage.runState = completed ? 'complete' : 'interrupted'
    for (const activity of responseMessage.activities ?? []) {
      if (activity.status === 'running') { activity.status = 'interrupted'; activity.error = 'Interrupted. Check the current deck for any saved changes.' }
    }
    writer.changed(); await writer.flush().catch(e => { error.value = `Chat could not be saved in this browser: ${String(e)}` })
    running.value = false; runId = ''; runToken = ''; chatController = undefined
  }
}
async function cancelChat() {
  if (runId) {
    try { await api(`/workspace-runs/${runId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${runToken}` } }) } catch (e) { error.value = String(e) }
  }
  chatController?.abort()
}
async function image(id: string, scale: number) {
  const renderer = editor.renderer
  if (!renderer) throw new Error('Canvas is not ready yet')
  const cleanup = await renderer.prepareForExport(graph, meta.pageId, [id])
  try {
    const bytes = renderNodesToImage(renderer.ck, renderer, graph, meta.pageId, [id], { scale, format: 'PNG' })
    if (!bytes) throw new Error('PNG rendering failed')
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
  } finally { cleanup() }
}
let renderingThumbnails = false
let thumbnailWork: Promise<void> | undefined
async function refreshThumbnails() {
  if (!ready.value || stopped || renderingThumbnails || saving.value || exportingPptx.value) return
  renderingThumbnails = true
  thumbnailWork = (async () => {
    for (const s of meta.slides) {
      if (exportingPptx.value || stopped) break
      const url = await image(s.id, 0.12)
      if (stopped) { URL.revokeObjectURL(url); break }
      if (thumbnails[s.id]) URL.revokeObjectURL(thumbnails[s.id]!)
      thumbnails[s.id] = url
    }
    for (const id of Object.keys(thumbnails)) {
      if (!meta.slides.some(s => s.id === id)) { URL.revokeObjectURL(thumbnails[id]!); delete thumbnails[id] }
    }
  })()
  try { await thumbnailWork } finally { renderingThumbnails = false; thumbnailWork = undefined }
}
async function exportPowerPoint(mode: PowerPointMode, event: Event) {
  const menu = (event.target as Element).closest('details')
  if (menu) menu.open = false
  if (locked.value || !ready.value) return
  exportingPptx.value = true
  error.value = ''
  exportReport.value = []
  exportFonts.value = []
  exportMessage.value = 'Preparing PowerPoint…'
  let cleanup: (() => void) | undefined
  try {
    await flush()
    if (thumbnailWork) await thumbnailWork
    const data = capture()
    const exportGraph = new SceneGraph()
    restore(exportGraph, data)
    const renderer = editor.renderer
    if (!renderer) throw new Error('Canvas is not ready for PowerPoint export.')
    cleanup = await renderer.prepareForExport(exportGraph, data.pageId, data.slides.map(s => s.id))
    const [{ createPowerPoint }, { rasterizePowerPointSlide }] = await Promise.all([import('./pptx-export'), import('./pptx-raster')])
    const result = await createPowerPoint(exportGraph, data, {
      mode,
      renderSlide: id => rasterizePowerPointSlide(exportGraph, data.pageId, id, renderer),
      textIssue: node => {
        if (!renderer.isNodeFontLoaded(node)) return `font "${node.fontFamily}" is unavailable to the renderer`
        const measured = renderer.measureTextNode(node, node.textAutoResize === 'WIDTH_AND_HEIGHT' ? undefined : node.width)
        if (!measured) return 'text layout could not be measured'
        if (measured.height > node.height + 1 || measured.width > node.width + 1) return 'text overflows its editable box'
        return null
      },
      onProgress: (completed, total) => { exportMessage.value = `Building PowerPoint: ${completed} / ${total} slides…` },
    })
    const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${data.title.replace(/[^\p{L}\p{N} _-]/gu, '_').slice(0, 120) || 'Pencil Slides'}.pptx`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    exportReport.value = result.report
    exportFonts.value = result.fonts
    const images = result.report.filter(s => s.mode === 'image').length
    exportMessage.value = `PowerPoint downloaded · ${result.report.length - images} editable ${result.report.length - images === 1 ? 'slide' : 'slides'}${images ? ` · ${images} image ${images === 1 ? 'slide' : 'slides'} (not individually editable)` : ''}`
  } catch (e) {
    error.value = `PowerPoint export failed: ${e instanceof Error ? e.message : String(e)}`
    exportMessage.value = ''
  } finally {
    cleanup?.()
    exportingPptx.value = false
    scheduleThumbnails()
  }
}
async function exportPng() {
  try {
    await flush()
    const url = await image(active.value, 1)
    const a = document.createElement('a')
    a.href = url; a.download = `${activeSlide.value.title.replace(/[^\w -]/g, '_')}.png`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    status.value = 'PNG exported'
  } catch (e) { error.value = String(e) }
}
async function present(index?: number) {
  try {
    if (index === undefined) await flush()
    else active.value = meta.slides[Math.max(0, Math.min(meta.slides.length - 1, index))]!.id
    if (presentImage.value) URL.revokeObjectURL(presentImage.value)
    presentImage.value = await image(active.value, 1)
    presenting.value = true
  } catch (e) { error.value = String(e) }
}
function presentationKey(e: KeyboardEvent) {
  if (!presenting.value) return
  if (e.key === 'Escape') { presenting.value = false; fit() }
  if (e.key === 'ArrowRight') void present(meta.slides.findIndex(s => s.id === active.value) + 1)
  if (e.key === 'ArrowLeft') void present(meta.slides.findIndex(s => s.id === active.value) - 1)
}
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value || saving.value || running.value || exportingPptx.value || comments.saving || comments.hasDraft) { e.preventDefault(); e.returnValue = '' }
}
function selectComment(id: string) {
  const thread = comments.threads.find(t => t.id === id)
  if (thread) comments.selectThread(thread)
}
function canvasRect() { return viewport.value?.querySelector('canvas')?.getBoundingClientRect() }
function reload() { window.location.reload() }
function commitOnOutside(event: PointerEvent) {
  if (state.editingTextId && !(event.target as Element).closest('canvas')) editor.commitTextEdit()
}
async function canvasReady() {
  ready.value = true
  await nextTick()
  fit()
  scheduleThumbnails()
}
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('keydown', presentationKey)
  viewportObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => { if (ready.value && !stopped) fit() })
  })
  if (viewport.value) viewportObserver.observe(viewport.value)
  try {
    if (!props.embedded) messages.value = await api(`/decks/${props.deck.id}/chat`)
    aiConfigured.value = (await api<{ aiConfigured: boolean }>('/health')).aiConfigured
  } catch (e) { error.value = String(e) }
})
onUnmounted(() => {
  stopped = true
  viewportObserver?.disconnect(); cancelAnimationFrame(resizeFrame)
  clearTimeout(saveTimer); clearTimeout(thumbnailTimer)
  chatController?.abort(); offHistory(); offNodes(); offSelection()
  editor.dispose()
  Object.values(thumbnails).forEach(url => URL.revokeObjectURL(url))
  if (presentImage.value) URL.revokeObjectURL(presentImage.value)
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('keydown', presentationKey)
})
defineExpose({ flush, execute, context: () => ({ selectedIds: [...state.selectedIds], name: selected.value?.name }) })
</script>

<template>
  <div :class="embedded ? 'embedded-editor' : 'workspace'" @pointerdown.capture="commitOnOutside">
    <aside v-if="!embedded" class="chat-panel" aria-label="Design conversation">
      <div class="conversation-heading"><span class="eyebrow">YOUR DESIGN PARTNER</span><span class="local-badge">Private workspace</span></div>
      <div class="chat-scroll" ref="chatScroll" @scroll="trackChatScroll">
        <section v-if="!messages.length" class="chat-welcome">
          <div class="welcome-mark" aria-hidden="true">p/</div>
          <h1>A little idea.<br>A great presentation.</h1>
          <p>Tell me what you’re imagining. We’ll shape the story, one slide at a time.</p>
          <ArtifactCard :artifact="currentArtifact" current :disabled="locked" @open="openArtifact(currentArtifact)" />
          <div class="suggestions">
            <button :disabled="locked" @click="suggest('Help me turn an idea into a three-slide pitch. Ask me what the pitch is about first.')">Turn an idea into a pitch <span aria-hidden="true">↗</span></button>
            <button :disabled="locked" @click="suggest('Read my current slide and suggest how to make its story clearer.')">Find a clearer story <span aria-hidden="true">↗</span></button>
          </div>
        </section>
        <div class="messages" aria-live="polite" aria-relevant="additions text">
          <article v-for="(m, i) in messages" :key="i" :class="['message', m.role]">
            <div class="message-author"><span v-if="m.role === 'assistant'" class="assistant-mark" aria-hidden="true">p/</span>{{ m.role === 'user' ? 'You' : 'Pencil' }}</div>
            <MarkdownMessage v-if="m.role === 'assistant' && m.content" :content="m.content" />
            <p v-else-if="m.content">{{ m.content }}</p>
            <p v-else-if="running && i === messages.length - 1" class="working-label"><span class="working-dot" />Working on your request…</p>
            <details v-if="m.activities?.length" class="tool-activity">
              <summary><span class="activity-symbol" aria-hidden="true">⌁</span>{{ activitySummary(m.activities) }}<span class="disclosure-arrow" aria-hidden="true">⌄</span></summary>
              <ul><li v-for="activity in m.activities" :key="activity.id" :class="activity.status">
                <span aria-hidden="true">{{ activity.status === 'complete' ? '✓' : activity.status === 'running' ? '•' : '!' }}</span>
                <div><strong>{{ toolName(activity) }}</strong><small>{{ activity.status === 'complete' ? (activity.revision === undefined ? 'Context returned by the editor' : `Saved in browser · revision ${activity.revision}`) : activity.error || 'Waiting for the editor' }}</small></div>
              </li></ul>
              <p class="activity-note">Actual editor actions and results. No private reasoning is displayed.</p>
            </details>
            <ArtifactCard v-for="artifact in m.artifacts" :key="artifact.revision" :artifact="artifact" :disabled="locked" @open="openArtifact(artifact)" />
          </article>
        </div>
      </div>
      <div class="composer-area">
        <div v-if="running" class="tool-status" role="status">{{ toolStatus || 'Connecting to your design partner…' }}</div>
        <details v-if="!aiConfigured" class="key-notice">
          <summary>Connect Claude to start a conversation <span aria-hidden="true">⌄</span></summary>
          <p>Add ANTHROPIC_API_KEY to the server’s .env and restart. Your key stays on the server. You can edit and present without it.</p>
        </details>
        <form class="composer" @submit.prevent="sendChat()">
          <div v-if="state.selectedIds.size" class="selection-context"><span aria-hidden="true">⌖</span>{{ state.selectedIds.size }} {{ state.selectedIds.size === 1 ? 'element' : 'elements' }} selected<span class="context-title">{{ selected?.name }}</span></div>
          <textarea ref="composer" aria-label="Message Claude" v-model="prompt" placeholder="How should we shape this?" :disabled="running || fatal" @keydown.meta.enter.prevent="sendChat()" @keydown.ctrl.enter.prevent="sendChat()" />
          <div class="composer-footer"><span class="model-label">Claude <span aria-hidden="true">·</span> Slide partner</span><button v-if="running" type="button" class="stop-button" @click="cancelChat">Stop <span aria-hidden="true">■</span></button><button v-else class="send-button" aria-label="Send message" :disabled="!aiConfigured || locked || !prompt.trim()" title="Send message (⌘/Ctrl + Enter)">↑</button></div>
        </form>
        <p class="privacy-note">Your deck stays local. AI receives context when you send.</p>
      </div>
    </aside>

    <main class="artifact-panel" ref="artifactPanel" aria-label="Slide deck artifact">
      <header class="artifact-heading">
        <div class="artifact-heading-icon" aria-hidden="true">▧</div>
        <div class="artifact-title"><span class="eyebrow">SLIDE DECK</span><input class="deck-title" aria-label="Deck title" v-model="titleInput" :disabled="locked" @change="renameDeck"></div>
        <span class="save-state" :class="{ unsaved: dirty || error }" role="status"><span class="save-dot" />{{ status }}<small>r{{ revision }}</small></span>
      </header>
      <div v-if="error" class="error" role="alert"><span>{{ error }}</span><button v-if="!fatal && !running" @click="flush().catch(() => {})">Retry save</button><button v-if="fatal" @click="reload">Reload</button></div>
      <div v-if="exportMessage" class="export-notice" role="status" aria-live="polite">
        <span v-if="exportingPptx" class="working-dot" />
        <div><strong>{{ exportMessage }}</strong>
          <details v-if="exportReport.length"><summary>Export details &amp; font requirements</summary>
            <p v-if="exportFonts.length">Editable text uses {{ exportFonts.join(', ') }}. Fonts are not embedded; install them in PowerPoint to minimize text reflow. Choose “Exact appearance” for rendered slides instead.</p>
            <ol><li v-for="slide in exportReport" :key="slide.id">{{ slide.title }} — {{ slide.mode === 'editable' ? 'editable text and shapes' : `rendered image: ${slide.reasons.join('; ')}` }}</li></ol>
          </details>
        </div>
        <button v-if="!exportingPptx" class="icon-button" aria-label="Dismiss export details" @click="exportMessage = ''">×</button>
      </div>
      <div class="toolbar">
        <div class="insert-controls">
          <button :disabled="locked" @click="addElement('TEXT')"><span class="text-tool" aria-hidden="true">T</span> Text</button>
          <details class="shape-menu">
            <summary> <span aria-hidden="true">▢</span> Shapes <span aria-hidden="true">⌄</span></summary>
            <div class="shape-options"><button :disabled="locked" @click="insertShape('RECTANGLE', $event)">▭ Rectangle</button><button :disabled="locked" @click="insertShape('ELLIPSE', $event)">◯ Ellipse</button></div>
          </details>
          <span class="toolbar-divider" />
          <button class="icon-button" aria-label="Undo" title="Undo" :disabled="locked || !canUndo" @click="editor.undoAction()">↶</button>
          <button class="icon-button" aria-label="Redo" title="Redo" :disabled="locked || !canRedo" @click="editor.redoAction()">↷</button>
        </div>
        <div class="artifact-actions">
          <button :class="{ active: comments.open }" :aria-expanded="comments.open" aria-controls="comments-sidebar" @click="comments.open = !comments.open"><span aria-hidden="true">◯</span> Comments <small v-if="comments.unresolvedCount">{{ comments.unresolvedCount }}</small></button>
          <button :class="{ active: propertiesOpen }" :aria-expanded="propertiesOpen" aria-controls="properties-panel" @click="propertiesOpen = !propertiesOpen"><span aria-hidden="true">☷</span> Properties</button>
          <button :disabled="locked || !ready" @click="exportPng"><span aria-hidden="true">↓</span> Export PNG</button>
          <details class="shape-menu pptx-menu">
            <summary><span aria-hidden="true">↓</span> PowerPoint <span aria-hidden="true">⌄</span></summary>
            <div class="shape-options">
              <button :disabled="locked || !ready" @click="exportPowerPoint('editable', $event)">Editable .pptx<small>Whole deck · image fallback if needed</small></button>
              <button :disabled="locked || !ready" @click="exportPowerPoint('appearance', $event)">Exact appearance .pptx<small>Whole deck · rendered slide images</small></button>
            </div>
          </details>
          <button class="present-button" :disabled="locked || !ready" @click="present()"><span aria-hidden="true">▷</span> Present</button>
        </div>
      </div>
      <div class="editing-area" :class="{ 'with-properties': propertiesOpen }">
        <div class="canvas-column">
          <div class="canvas-caption"><span>{{ activeSlide.title }}</span><span>1920 × 1080</span></div>
          <div v-if="comments.pointMode" class="point-comment-banner" id="comment-mode-instructions"><span>Click a point on the slide. Arrow keys move the pin; Enter places it; Escape cancels.</span><button type="button" @click="comments.pointMode = false">Cancel pinning</button></div>
          <div class="viewport" ref="viewport" :class="{ locked }" @pointerdown.self="!locked && editor.clearSelection()">
            <CanvasPane :locked="locked || contextMenuOpen" :frame-id="active" @ready="canvasReady" @interaction="canvasInteracting = $event" />
            <CanvasContextMenu v-if="ready && !presenting" :host="viewport" :editor="editor" :frame-id="active" :blocked="locked" :comments-ready="comments.loaded" :comments-loading="comments.loading"
              @open-change="contextMenuOpen = $event" @add-comment="comments.startAt" />
            <CommentOverlay v-if="ready && !presenting" :graph="graph" :view="state" :slide-id="active" :point-mode="comments.pointMode" :disabled="locked || contextMenuOpen" :focused-id="comments.focusedId"
              :draft-pin="comments.draftPin" :pins="comments.pins" :canvas-rect="canvasRect" @select="selectComment" @place="comments.placePoint" @cancel="comments.pointMode = false" @error="comments.error = $event" />
            <SelectionToolbar v-if="ready && toolbarNode" :key="toolbarNode.id" :editor="editor" :node="toolbarNode" :version="generation + state.sceneVersion + state.renderVersion" :host="viewport"
              :hidden="Boolean(contextMenuOpen || canvasInteracting || state.editingTextId || externalBusy || running || presenting || exportingPptx || comments.pointMode || comments.draftAnchor || comments.saving)"
              :disabled="locked" :comments-ready="comments.loaded" @format="formatSelection" @comment="selectionComment" @properties="selectionProperties" @dismiss="dismissSelectionToolbar" />
            <div v-if="!ready" class="canvas-loading"><span class="working-dot" />Preparing your canvas…</div>
          </div>
          <div class="canvas-hint">Double-click text to edit <span>·</span> Drag to move or resize</div>
        </div>
        <aside v-if="propertiesOpen" id="properties-panel" class="properties" aria-label="Slide properties">
          <div class="panel-heading">Properties<button class="icon-button" aria-label="Close properties" @click="propertiesOpen = false">×</button></div>
          <section class="property-section">
            <label class="field">Slide title<input :value="activeSlide.title" :disabled="locked" @change="manual([{ op: 'update_slide', id: active, title: ($event.target as HTMLInputElement).value }])"></label>
            <label class="field color-field">Background<input type="color" aria-label="Slide background" :value="hexFill(graph.getNode(active))" :disabled="locked" @change="manual([{ op: 'update_slide', id: active, background: ($event.target as HTMLInputElement).value }])"></label>
          </section>
          <section class="property-section">
            <h3>Elements <span>{{ layers.length }}</span></h3>
            <div class="layer-list"><button v-for="n in layers" :key="n.id" :class="{ active: state.selectedIds.has(n.id) }" :disabled="locked" @click="editor.select([n.id])"><span aria-hidden="true">{{ n.type === 'TEXT' ? 'T' : '▢' }}</span>{{ n.name }}</button></div>
            <p v-if="!layers.length" class="hint">Add text or a shape to get started.</p>
          </section>
          <section v-if="selected && selected.type !== 'FRAME'" class="property-section property-fields">
            <label class="field full-field">Name<input :value="selected.name" :disabled="locked" @change="updateProperty('name', $event)"></label>
            <label v-for="key in (['x', 'y', 'width', 'height', 'rotation'] as const)" :key="key" class="field">{{ key }}<input type="number" :aria-label="key" :value="Math.round(selected[key])" :disabled="locked" @change="updateProperty(key, $event)"></label>
            <label class="field">Fill<input type="color" aria-label="Element fill" :value="hexFill(selected)" :disabled="locked" @change="updateProperty('fill', $event)"></label>
            <template v-if="selected.type === 'TEXT'">
              <label class="field full-field">Font size<input type="number" aria-label="Font size" :value="selected.fontSize" :disabled="locked" @change="updateProperty('fontSize', $event)"></label>
              <label class="field full-field">Text<textarea aria-label="Selected text" :value="selected.text" :disabled="locked" @change="updateProperty('text', $event)" /></label>
            </template>
            <button class="full-field danger-button" :disabled="locked" @click="manual([{ op: 'delete_element', id: selected.id }])">Delete element</button>
          </section>
          <p v-else-if="layers.length" class="hint">Select an element on the canvas or in the list to adjust its properties.</p>
          <section class="property-section slide-management">
            <h3>Slide order</h3>
            <div class="row"><button aria-label="Move slide earlier" :disabled="locked || activeIndex === 0" @click="reorder(-1)">← Move earlier</button><button aria-label="Move slide later" :disabled="locked || activeIndex === meta.slides.length - 1" @click="reorder(1)">Later →</button></div>
            <button class="danger-button" :disabled="locked || meta.slides.length === 1" @click="manual([{ op: 'delete_slide', id: active }])">Delete slide</button>
          </section>
        </aside>
        <CommentsSidebar v-if="comments.open" id="comments-sidebar" :class="{ 'pinning-comments': comments.pointMode }" :controller="commentState" :busy="artworkBusy || !ready" :ai-configured="aiConfigured" :current-slide-title="activeSlide.title" />
      </div>
      <footer class="canvas-footer">
        <div class="slide-navigation"><button class="icon-button" aria-label="Previous slide" :disabled="locked || activeIndex === 0" @click="stepSlide(-1)">‹</button><span>{{ activeIndex + 1 }} <span class="muted">/ {{ meta.slides.length }}</span></span><button class="icon-button" aria-label="Next slide" :disabled="locked || activeIndex === meta.slides.length - 1" @click="stepSlide(1)">›</button></div>
        <button class="thumbnails-toggle" :class="{ active: thumbnailsOpen }" :aria-expanded="thumbnailsOpen" aria-controls="slide-thumbnails" @click="thumbnailsOpen = !thumbnailsOpen"><span aria-hidden="true">▥</span> Thumbnails</button>
        <div class="zoom-controls"><button class="icon-button" aria-label="Zoom out" :disabled="locked || !ready" @click="zoom(0.8)">−</button><span>{{ Math.round(state.zoom * 100) }}%</span><button class="icon-button" aria-label="Zoom in" :disabled="locked || !ready" @click="zoom(1.25)">+</button><button :disabled="locked || !ready" @click="fit()">Fit</button></div>
      </footer>
      <nav v-show="thumbnailsOpen" id="slide-thumbnails" class="slides-panel" aria-label="Slides">
        <div class="slides-list">
          <button v-for="(s, i) in meta.slides" :key="s.id" class="slide-card" :class="{ active: active === s.id }" :aria-current="active === s.id ? 'true' : undefined" :disabled="locked" @click="navigate(s.id)" :aria-label="`Slide ${i + 1}: ${s.title}`">
            <img v-if="thumbnails[s.id]" :src="thumbnails[s.id]" alt="">
            <div v-else class="thumbnail-placeholder">{{ s.title }}</div>
            <span class="slide-caption"><b>{{ i + 1 }}</b><span>{{ s.title }}</span></span>
          </button>
          <button class="add-slide" :disabled="locked" @click="addSlide"><span aria-hidden="true">+</span>Add slide</button>
        </div>
      </nav>
    </main>
  </div>
  <div v-if="presenting" class="presentation" role="dialog" aria-label="Presentation">
    <img :src="presentImage" :alt="activeSlide.title">
    <div class="presentation-controls"><button :disabled="activeIndex === 0" @click="present(activeIndex - 1)">← Previous</button><span>{{ activeIndex + 1 }} / {{ meta.slides.length }}</span><button :disabled="activeIndex === meta.slides.length - 1" @click="present(activeIndex + 1)">Next →</button><button @click="presenting = false; fit()">Exit (Esc)</button></div>
  </div>
</template>
