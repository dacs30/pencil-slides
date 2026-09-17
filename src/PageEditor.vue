<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { createDefaultEditorState, createEditor } from '@open-pencil/core/editor'
import { computeLayout } from '@open-pencil/core/layout'
import { SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import { provideEditor } from '@open-pencil/vue'
import { pageBatchSchema, pageReadSchema, pageElementProps, pageOperationSchema, type PageArtifact, type PageSnapshot, type PageOperation } from '../shared/page'
import type { Command, ToolResult, ElementProperties } from '../shared/model'
import { capturePage, restorePage, applyPageOperations, pageSizing } from './page-document'
import { pageHtml } from './page-html'
import { saveWithReceipt, UnknownSaveOutcome } from './artifact-save'
import { ApiError } from './api'
import CanvasPane from './CanvasPane.vue'
import SelectionToolbar from './SelectionToolbar.vue'
import { useComments } from './useComments'
import CommentsSidebar from './CommentsSidebar.vue'
import CommentOverlay from './CommentOverlay.vue'
import CanvasContextMenu from './CanvasContextMenu.vue'
import { slidePointToViewport, type Point } from './comment-geometry'
import type { CommentHandoff } from '../shared/comments'

const props = defineProps<{ page: PageArtifact; saveBase: string; externalBusy: boolean; aiConfigured: boolean }>()
const emit = defineEmits<{ saved: []; lock: [value: boolean]; selection: [value: unknown]; handoff: [request: CommentHandoff] }>()
const graph = new SceneGraph()
restorePage(graph, props.page.snapshot)
const meta = reactive({ title: props.page.snapshot.title, pageId: props.page.snapshot.pageId, frameId: props.page.snapshot.frameId })
const viewport = ref<HTMLElement>(), previewHost = ref<HTMLElement>()
const state = reactive(createDefaultEditorState(meta.pageId))
const editor = createEditor({ graph, state, getViewportSize: () => ({ width: viewport.value?.clientWidth ?? 900, height: viewport.value?.clientHeight ?? 600 }) })
provideEditor(editor)
const titleInput = ref(meta.title), revision = ref(props.page.revision), generation = ref(0)
const ready = ref(false), saving = ref(false), dirty = ref(false), fatal = ref(false), error = ref(''), status = ref('Saved')
const propertiesOpen = ref(false), interacting = ref(false), preview = ref(false), previewSource = ref(''), previewMode = ref<'fill' | 'fit'>('fill')
const previewSize = reactive({ width: 900, height: 600 })
const artworkBusy = computed(() => props.externalBusy || saving.value || fatal.value)
const active = ref(meta.frameId), contextMenuOpen = ref(false)
const commentState = useComments({
  deckId: props.page.id, editor, active, revision, generation, artworkBusy, flush,
  commentsBase: `${props.saveBase}/comments`, surface: 'page',
  navigate: id => { if (id === meta.frameId) fit() }, reveal: revealPoint,
  handoff: async request => { emit('handoff', request) },
})
const comments = reactive(commentState)
const locked = computed(() => artworkBusy.value || comments.saving || comments.pointMode)
const root = computed(() => { generation.value; state.sceneVersion; return graph.getNode(meta.frameId)! })
const selected = computed(() => { generation.value; state.sceneVersion; return graph.getNode([...state.selectedIds][0] ?? '') })
const inspector = computed(() => selected.value ?? root.value)
const toolbarNode = computed(() => selected.value && selected.value.type !== 'FRAME' ? selected.value : undefined)
const nodes = computed(() => {
  generation.value; state.sceneVersion
  const result: { node: SceneNode; depth: number }[] = []
  function walk(id: string, depth: number) { for (const node of graph.getChildren(id)) { result.push({ node, depth }); walk(node.id, depth + 1) } }
  walk(meta.frameId, 0)
  return result
})
const canUndo = computed(() => { generation.value; return editor.undo.canUndo })
const canRedo = computed(() => { generation.value; return editor.undo.canRedo })
const previewScale = computed(() => Math.min(1, previewSize.width / root.value.width))
const iframeStyle = computed(() => previewMode.value === 'fill'
  ? { width: '100%', height: '100%', transform: 'none' }
  : { width: `${root.value.width}px`, height: `${previewSize.height / previewScale.value}px`, transform: `scale(${previewScale.value})` })
let lastSaved = JSON.stringify(props.page.snapshot), timer: ReturnType<typeof setTimeout> | undefined
let pending: Promise<void> | undefined, suppressed = false, disposed = false
let resize: ResizeObserver | undefined
watch([locked, dirty, commentState.hasDraft], () => emit('lock', locked.value || dirty.value || comments.hasDraft), { immediate: true })
watch(propertiesOpen, value => { if (value) comments.open = false })
watch(commentState.open, value => { if (value) propertiesOpen.value = false })
watch(() => [...state.selectedIds].join('\0'), () => emit('selection', context()), { immediate: true })
function context() { return { selectedIds: [...state.selectedIds], name: selected.value?.name } }
function capture() { return capturePage(graph, meta) }
function restoreAll(snapshot: PageSnapshot) {
  restorePage(graph, snapshot); meta.title = snapshot.title; titleInput.value = snapshot.title
  editor.clearSelection(); editor.renderer?.invalidateAllPictures(); editor.requestRender(); generation.value++
}
function fit() {
  if (!ready.value || preview.value) return
  editor.zoomToBounds(root.value.x, root.value.y, root.value.x + root.value.width, root.value.y + Math.min(root.value.height, 800))
}
function zoom(factor: number) { editor.setZoomAroundPoint(Math.max(.1, Math.min(2, state.zoom * factor)), (viewport.value?.clientWidth ?? 0) / 2, (viewport.value?.clientHeight ?? 0) / 2) }
function changed() {
  if (suppressed || disposed) return
  dirty.value = true; generation.value++; status.value = 'Unsaved changes'
  clearTimeout(timer); timer = setTimeout(() => { void flush().catch(() => { /* Save error is displayed. */ }) }, 1200)
}
const offHistory = editor.onEditorEvent('history:changed', changed)
const offNodes = graph.onNodeEvents({ updated: (_id, changes) => {
  if (suppressed) return
  generation.value++
  if (state.editingTextId && ('text' in changes || 'styleRuns' in changes)) { dirty.value = true; status.value = 'Editing text...' }
} })
const offSelection = editor.onEditorEvent('selection:changed', ids => { if (ids.includes(meta.frameId)) editor.select(ids.filter(id => id !== meta.frameId)) })
async function persist(snapshot: PageSnapshot, commandId: string) {
  try {
    const html = preview.value ? pageHtml(snapshot, { localFonts: true }) : undefined
    const saved = await saveWithReceipt(props.saveBase, JSON.stringify({ expectedRevision: revision.value, commandId, snapshot }), commandId)
    revision.value = saved.revision; lastSaved = JSON.stringify(snapshot)
    dirty.value = false; status.value = 'Saved'; error.value = ''; emit('saved')
    void comments.reload()
    if (html !== undefined) previewSource.value = html
    return { revision: revision.value }
  } catch (e) {
    if (e instanceof UnknownSaveOutcome || e instanceof ApiError && e.status === 409) fatal.value = true
    error.value = String(e); status.value = fatal.value ? 'Reload required' : 'Save failed'; throw e
  }
}
async function flush() {
  clearTimeout(timer)
  if (state.editingTextId) editor.commitTextEdit()
  if (pending) return pending
  if (fatal.value) throw new Error('Reload this page before editing.')
  pending = (async () => {
    try {
      suppressed = true; computeLayout(graph, meta.frameId)
      const snapshot = capture()
      if (JSON.stringify(snapshot) === lastSaved) { dirty.value = false; return }
      saving.value = true
      await persist(snapshot, crypto.randomUUID())
    } catch (e) { error.value = String(e); throw e }
    finally { saving.value = false; suppressed = false; generation.value++ }
  })()
  try { await pending } finally { pending = undefined }
}
async function batch(operations: PageOperation[], commandId: string = crypto.randomUUID(), expected = revision.value) {
  if (fatal.value || expected !== revision.value) throw new Error('Revision conflict. Read the current page first.')
  const before = capture(), selection = [...state.selectedIds]
  clearTimeout(timer); suppressed = true; saving.value = true
  try {
    applyPageOperations(graph, meta, operations.map(op => pageOperationSchema.parse(op)))
    const after = capture()
    const saved = await persist(after, commandId)
    editor.pushUndoEntry({ label: 'Edit page', forward: () => restoreAll(after), inverse: () => restoreAll(before) })
    titleInput.value = meta.title
    editor.requestRender(); generation.value++
    return saved
  } catch (e) {
    if (!fatal.value) { restoreAll(before); editor.select(selection.filter(id => graph.getNode(id))) }
    error.value = String(e); throw e
  } finally { suppressed = false; saving.value = false }
}
async function manual(operations: PageOperation[]) {
  if (locked.value) return
  try { await flush(); await batch(operations) } catch (e) { error.value = String(e) }
}
async function insert(type: 'FRAME' | 'TEXT' | 'RECTANGLE' | 'ELLIPSE') {
  const id = `element-${crypto.randomUUID()}`
  const parentId = selected.value?.type === 'FRAME' ? selected.value.id : meta.frameId
  await manual([{ op: 'create_page_element', id, parentId, type, props: type === 'TEXT' ? { text: 'Your text', fontSize: 26 } : {} }])
  if (graph.getNode(id)) { editor.select([id]); propertiesOpen.value = true }
}
async function updateProperties(raw: unknown) {
  try {
    const values = pageElementProps.parse(raw)
    if (values.width !== undefined && inspector.value.id === meta.frameId) await manual([{ op: 'update_page', width: values.width }])
    else await manual([{ op: 'update_page_element', id: inspector.value.id, props: { ...values, ...(values.width !== undefined ? { layoutSizingHorizontal: 'FIXED' as const } : {}) } }])
  } catch (e) { error.value = String(e) }
}
function updateField(key: string, event: Event, numeric = false) {
  const value = (event.target as HTMLInputElement).value
  void updateProperties({ [key]: numeric ? Number(value) : value })
}
async function format(id: string, values: ElementProperties) {
  if (selected.value?.id !== id || locked.value) return
  await updateProperties(values)
}
function color(node: SceneNode) {
  const c = node.fills[0]?.color
  return c ? '#' + [c.r, c.g, c.b].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('') : '#ffffff'
}
function reorder(delta: number) {
  const node = selected.value
  if (!node?.parentId) return
  const siblings = graph.getNode(node.parentId)!.childIds, index = siblings.indexOf(node.id) + delta
  if (index >= 0 && index < siblings.length) void manual([{ op: 'move_page_element', id: node.id, parentId: node.parentId, index }])
}
function revealPoint(point: Point) {
  const projected = slidePointToViewport(graph, meta.frameId, point, state)
  if (!projected || !viewport.value) return
  state.panX += viewport.value.clientWidth / 2 - projected.x
  state.panY += viewport.value.clientHeight / 2 - projected.y
  editor.requestRender()
}
function selectComment(id: string) {
  const thread = comments.threads.find(t => t.id === id)
  if (thread) comments.selectThread(thread)
}
function canvasRect() { return viewport.value?.querySelector('canvas')?.getBoundingClientRect() }
function commentSelection(id: string) { if (!locked.value) void comments.startAt({ kind: 'object', slideId: meta.frameId, nodeId: id }) }
async function execute(command: Command): Promise<ToolResult> {
  try {
    if (fatal.value) throw new Error('Reload this page before continuing.')
    if (command.name === 'read_context') {
      const input = pageReadSchema.parse(command.input)
      if (input.slideId && input.slideId !== meta.frameId) throw new Error('The referenced page artboard no longer exists.')
      const included = new Set(state.selectedIds)
      const includeChildren = (id: string) => { for (const child of graph.getChildren(id)) { included.add(child.id); includeChildren(child.id) } }
      for (const id of state.selectedIds) includeChildren(id)
      const readNodes = [root.value, ...nodes.value.map(n => n.node)].filter(n => input.view === 'page' || included.has(n.id))
      return { ok: true, data: {
      kind: 'page', artifactId: props.page.id, title: meta.title, revision: revision.value, frameId: meta.frameId, selectedIds: [...state.selectedIds],
      nodes: readNodes.map(n => ({
        id: n.id, parentId: n.parentId, type: n.type, name: n.name, text: n.type === 'TEXT' ? n.text : undefined,
        x: n.x, y: n.y, width: n.width, height: n.height, fontSize: n.fontSize, fontWeight: n.fontWeight, fill: color(n),
        layoutMode: n.layoutMode, layoutWrap: n.layoutWrap, layoutSizingHorizontal: pageSizing(n, n.parentId ? graph.getNode(n.parentId) : undefined, 'HORIZONTAL'),
        layoutSizingVertical: pageSizing(n, n.parentId ? graph.getNode(n.parentId) : undefined, 'VERTICAL'),
        itemSpacing: n.itemSpacing, paddingTop: n.paddingTop, paddingRight: n.paddingRight, paddingBottom: n.paddingBottom, paddingLeft: n.paddingLeft,
      })),
      } }
    }
    const input = pageBatchSchema.parse(command.input)
    return { ok: true, data: await batch(input.operations, command.id, input.expectedRevision) }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}
async function openPreview() {
  if (locked.value) return
  if (comments.hasDraft) { comments.error = 'Post or cancel your comment draft before opening the preview.'; comments.open = true; return }
  try { await flush(); previewSource.value = pageHtml(capture(), { localFonts: true }); comments.open = false; preview.value = true }
  catch (e) { error.value = `Page preview failed: ${e instanceof Error ? e.message : e}` }
}
async function back() { preview.value = false; await nextTick(); fit(); viewport.value?.querySelector('canvas')?.focus() }
async function exportHtml() {
  if (locked.value) return
  try {
    await flush()
    const url = URL.createObjectURL(new Blob([pageHtml(capture())], { type: 'text/html;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = `${meta.title.replace(/[^\p{L}\p{N} _-]/gu, '_').slice(0, 120) || 'Page'}.html`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  } catch (e) { error.value = `HTML export failed: ${e instanceof Error ? e.message : e}` }
}
async function canvasReady() { ready.value = true; await nextTick(); fit() }
function outside(e: PointerEvent) { if (state.editingTextId && !(e.target as Element).closest('canvas')) editor.commitTextEdit() }
function unload(e: BeforeUnloadEvent) { if (dirty.value || saving.value || props.externalBusy || comments.saving || comments.hasDraft) { e.preventDefault(); e.returnValue = '' } }
function reload() { window.location.reload() }
onMounted(() => {
  window.addEventListener('beforeunload', unload)
  resize = new ResizeObserver(() => {
    if (previewHost.value?.clientWidth) { previewSize.width = previewHost.value.clientWidth; previewSize.height = previewHost.value.clientHeight }
  })
  if (previewHost.value) resize.observe(previewHost.value)
})
onUnmounted(() => { disposed = true; clearTimeout(timer); resize?.disconnect(); offHistory(); offNodes(); offSelection(); editor.dispose(); window.removeEventListener('beforeunload', unload) })
defineExpose({ flush, execute, context })
</script>

<template>
  <main class="artifact-panel page-artifact" aria-label="Page artifact" @pointerdown.capture="outside">
    <header class="artifact-heading">
      <div class="artifact-heading-icon" aria-hidden="true">P</div>
      <div class="artifact-title"><span class="eyebrow">DESIGNED PAGE</span><input class="deck-title" aria-label="Page title" v-model="titleInput" :disabled="locked" @change="manual([{ op: 'update_page', title: titleInput }])"></div>
      <span class="save-state" role="status">{{ status }} <small>r{{ revision }}</small></span>
    </header>
    <div v-if="error" class="error" role="alert">{{ error }}<button v-if="fatal" @click="reload">Reload</button><button v-else :disabled="locked" @click="flush().catch(() => {})">Retry save</button></div>
    <div v-if="preview" class="toolbar page-preview-toolbar" role="toolbar" aria-label="Full window controls">
      <button @click="back">Back to canvas</button><span>{{ meta.title }}</span>
      <div role="radiogroup" aria-label="Artboard size"><button role="radio" :aria-checked="previewMode === 'fill'" @click="previewMode = 'fill'">Fill</button><button role="radio" :aria-checked="previewMode === 'fit'" @click="previewMode = 'fit'">Fit</button></div>
      <button :disabled="locked" @click="exportHtml">Export HTML</button>
    </div>
    <div v-else class="toolbar page-tools" role="toolbar" aria-label="Page actions">
      <span>Page 1</span><button :disabled="locked" @click="insert('TEXT')">Text</button><button :disabled="locked" @click="insert('FRAME')">Section</button>
      <details class="shape-menu"><summary>Shapes</summary><div class="shape-options"><button :disabled="locked" @click="insert('RECTANGLE')">Rectangle</button><button :disabled="locked" @click="insert('ELLIPSE')">Ellipse</button></div></details>
      <button aria-label="Undo" :disabled="locked || !canUndo" @click="editor.undoAction()">Undo</button><button aria-label="Redo" :disabled="locked || !canRedo" @click="editor.redoAction()">Redo</button>
      <button :aria-expanded="propertiesOpen" @click="propertiesOpen = !propertiesOpen">Properties</button>
      <button :aria-expanded="comments.open" aria-controls="page-comments-sidebar" @click="comments.open = !comments.open">Comments <small v-if="comments.unresolvedCount">{{ comments.unresolvedCount }}</small></button>
      <button :disabled="locked || !ready" @click="openPreview">Open full window</button>
    </div>
    <div v-show="preview" ref="previewHost" class="page-html-viewport">
      <iframe v-if="preview" title="Page full window preview" :srcdoc="previewSource" sandbox="allow-same-origin" :style="iframeStyle" />
    </div>
    <div v-show="!preview" class="page-editing-area">
      <div class="page-canvas-column">
        <div class="canvas-caption"><span>{{ meta.title }}</span><span>{{ Math.round(root.width) }} x {{ Math.round(root.height) }}</span></div>
        <div v-if="comments.pointMode" id="comment-mode-instructions" class="point-comment-banner"><span>Click inside the page, or use arrow keys and Enter. Escape cancels.</span><button @click="comments.pointMode = false">Cancel pinning</button></div>
        <div ref="viewport" class="viewport page-canvas">
          <CanvasPane :locked="locked || contextMenuOpen" :frame-id="meta.frameId" label="Editable page canvas" @ready="canvasReady" @interaction="interacting = $event" />
          <CanvasContextMenu v-if="ready && !preview" :host="viewport" :editor="editor" :frame-id="meta.frameId" :blocked="locked" :comments-ready="comments.loaded" :comments-loading="comments.loading" surface="page"
            @open-change="contextMenuOpen = $event" @add-comment="comments.startAt" />
          <CommentOverlay v-if="ready && !preview" :graph="graph" :view="state" :slide-id="meta.frameId" :point-mode="comments.pointMode" :disabled="locked || contextMenuOpen" :focused-id="comments.focusedId" surface="page"
            :draft-pin="comments.draftPin" :pins="comments.pins" :canvas-rect="canvasRect" @select="selectComment" @place="comments.placePoint" @cancel="comments.pointMode = false" @error="comments.error = $event" @preview-move="revealPoint" />
          <SelectionToolbar v-if="ready && toolbarNode" :key="toolbarNode.id" :editor="editor" :node="toolbarNode" :version="generation + state.sceneVersion + state.renderVersion" :host="viewport"
            :hidden="Boolean(interacting || state.editingTextId || locked || preview || contextMenuOpen || comments.draftAnchor)" :disabled="locked" :comments-ready="comments.loaded" @format="format" @comment="commentSelection" @properties="propertiesOpen = true" @dismiss="editor.clearSelection()" />
          <div v-if="!ready" class="canvas-loading">Preparing OpenPencil...</div>
        </div>
        <div class="canvas-hint">Double-click text to edit · Auto-layout sections reflow in Fill view</div>
      </div>
      <aside v-if="propertiesOpen" class="properties page-properties" aria-label="Page properties">
        <div class="panel-heading">Properties<button aria-label="Close properties" @click="propertiesOpen = false">X</button></div>
        <section class="property-section">
          <label class="field">Name<input aria-label="Element name" :value="inspector.name" :disabled="locked" @change="updateField('name', $event)"></label>
          <label class="field">Width<input aria-label="Page element width" type="number" :value="Math.round(inspector.width)" :disabled="locked" @change="updateField('width', $event, true)"></label>
          <label class="field">Fill<input aria-label="Page element fill" type="color" :value="color(inspector)" :disabled="locked" @change="updateField('fill', $event)"></label>
          <template v-if="inspector.type === 'TEXT'">
            <label class="field">Text<textarea aria-label="Selected page text" :value="inspector.text" :disabled="locked" @change="updateField('text', $event)" /></label>
            <label class="field">Font size<input aria-label="Page font size" type="number" :value="inspector.fontSize" :disabled="locked" @change="updateField('fontSize', $event, true)"></label>
          </template>
          <template v-if="inspector.type === 'FRAME'">
            <label class="field">Layout<select aria-label="Page section layout" :value="inspector.layoutMode" :disabled="locked" @change="updateField('layoutMode', $event)"><option value="VERTICAL">Vertical</option><option value="HORIZONTAL">Horizontal</option><option value="NONE">Freeform</option></select></label>
            <label class="field">Wrap<select aria-label="Page section wrap" :value="inspector.layoutWrap" :disabled="locked" @change="updateField('layoutWrap', $event)"><option value="NO_WRAP">No wrap</option><option value="WRAP">Wrap</option></select></label>
            <label v-for="key in (['itemSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft'] as const)" :key="key" class="field">{{ key }}<input type="number" :aria-label="key" :value="inspector[key]" :disabled="locked" @change="updateField(key, $event, true)"></label>
          </template>
          <div v-if="selected" class="row"><button :disabled="locked" @click="reorder(-1)">Move earlier</button><button :disabled="locked" @click="reorder(1)">Move later</button></div>
          <button v-if="selected" class="danger-button" :disabled="locked" @click="manual([{ op: 'delete_page_element', id: selected.id }])">Delete element</button>
        </section>
        <section class="property-section"><h3>Outline</h3><div class="layer-list">
          <button :disabled="locked" @click="editor.clearSelection()">Page artboard</button>
          <button v-for="item in nodes" :key="item.node.id" :disabled="locked" :class="{ active: selected?.id === item.node.id }" :aria-label="`Select ${item.node.name}`" @click="editor.select([item.node.id])">{{ '— '.repeat(item.depth) }}{{ item.node.name }}</button>
        </div></section>
      </aside>
      <CommentsSidebar v-if="comments.open && !preview" id="page-comments-sidebar" :class="{ 'pinning-comments': comments.pointMode }" :controller="commentState" :busy="artworkBusy || !ready" :ai-configured="aiConfigured" :current-slide-title="meta.title" />
    </div>
    <footer v-if="!preview" class="canvas-footer"><span>OpenPencil design · HTML full-window view</span><div class="zoom-controls"><button aria-label="Zoom out" :disabled="locked" @click="zoom(.8)">-</button><span>{{ Math.round(state.zoom * 100) }}%</span><button aria-label="Zoom in" :disabled="locked" @click="zoom(1.25)">+</button><button :disabled="locked" @click="fit">Fit canvas</button><button :disabled="locked" @click="exportHtml">Export HTML</button></div></footer>
  </main>
</template>
