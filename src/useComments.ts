import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { Editor } from '@open-pencil/core/editor'
import { api } from './api'
import { objectPointOnSlide, resolveCommentAnchor, slidePointToViewport, type Point } from './comment-geometry'
import { detachmentLabel, type CommentAnchorInput, type CommentHandoff, type CommentThread } from '../shared/comments'

export function useComments(options: {
  deckId: string; editor: Editor; active: Ref<string>; revision: Ref<number>; generation: Ref<number>
  artworkBusy: Ref<boolean>; flush: () => Promise<void>; navigate: (id: string) => void
  handoff: (request: CommentHandoff) => Promise<void>
  commentsBase?: string; surface?: 'slide' | 'page'; reveal?: (point: Point) => void
}) {
  const { editor, active } = options
  const commentsBase = options.commentsBase ?? `/decks/${options.deckId}/comments`
  const surface = options.surface ?? 'slide'
  const threads = ref<CommentThread[]>([])
  const open = ref(false), loading = ref(false), loaded = ref(false), saving = ref(false), pointMode = ref(false), showResolved = ref(false)
  const error = ref(''), focusedId = ref<string | null>(null)
  const draftAnchor = ref<CommentAnchorInput | null>(null), draftBody = ref(''), replyBody = ref('')
  let draftId = crypto.randomUUID(), replyId = crypto.randomUUID(), requestGeneration = 0, destroyed = false
  const focused = computed(() => threads.value.find(t => t.id === focusedId.value))
  const hasDraft = computed(() => Boolean(draftBody.value.trim() || replyBody.value.trim()))
  const visible = computed(() => threads.value.filter(t => showResolved.value || !t.resolved))
  const unresolvedCount = computed(() => threads.value.filter(t => !t.resolved).length)
  const number = (id: string) => threads.value.findIndex(t => t.id === id) + 1
  const attachment = (thread: CommentThread) => {
    options.generation.value; editor.state.renderVersion; editor.state.sceneVersion
    return resolveCommentAnchor(editor.graph, thread)
  }
  const locationLabel = (thread: CommentThread) => {
    const resolved = attachment(thread)
    return detachmentLabel(resolved.detached, surface) || (resolved.offSlide ? `${thread.anchor.kind === 'object' ? 'Object' : 'Point'} is outside the ${surface} bounds` : thread.anchor.kind === 'object' ? `Object · ${editor.graph.getNode(thread.anchor.nodeId!)?.name ?? thread.nodeName}` : `Point on ${surface}`)
  }
  const slideTitle = (thread: CommentThread) => {
    options.generation.value
    return thread.detached === 'slide_deleted' ? thread.slideTitle : editor.graph.getNode(thread.anchor.slideId)?.name ?? thread.slideTitle
  }
  const pins = computed(() => visible.value.flatMap(thread => {
    const resolved = attachment(thread)
    if (thread.anchor.slideId !== active.value || !resolved.point) return []
    const position = slidePointToViewport(editor.graph, active.value, resolved.point, editor.state)
    return position ? [{ id: thread.id, number: number(thread.id), position, detached: Boolean(resolved.detached), resolved: thread.resolved, body: thread.messages[0]?.body ?? '' }] : []
  }))
  const canAttach = computed(() => {
    options.generation.value
    const id = [...editor.state.selectedIds][0]
    return Boolean(id && objectPointOnSlide(editor.graph, id, active.value))
  })
  const draftPin = computed(() => {
    options.generation.value; editor.state.renderVersion
    const anchor = draftAnchor.value
    if (!anchor || anchor.slideId !== active.value) return null
    const point = anchor.kind === 'point' ? anchor : objectPointOnSlide(editor.graph, anchor.nodeId, anchor.slideId)
    return point ? slidePointToViewport(editor.graph, anchor.slideId, point, editor.state) : null
  })
  async function reload() {
    const token = ++requestGeneration
    loading.value = true
    try {
      const result = await api<CommentThread[]>(commentsBase)
      if (destroyed || token !== requestGeneration) return false
      threads.value = result; loaded.value = true; error.value = ''
      return true
    } catch (e) {
      if (!destroyed && token === requestGeneration) error.value = `Comments could not be loaded: ${e instanceof Error ? e.message : String(e)}`
      return false
    } finally { if (token === requestGeneration) loading.value = false }
  }
  function upsert(thread: CommentThread) {
    const index = threads.value.findIndex(t => t.id === thread.id)
    if (index < 0) threads.value.push(thread)
    else threads.value[index] = thread
  }
  function cancelDraft() { draftAnchor.value = null; draftBody.value = ''; draftId = crypto.randomUUID(); pointMode.value = false }
  function cancelReply() { replyBody.value = ''; replyId = crypto.randomUUID() }
  function canStart() {
    if (options.artworkBusy.value || saving.value || !loaded.value) return false
    if (hasDraft.value) { error.value = 'Post or cancel your draft before starting another comment.'; return false }
    error.value = ''; return true
  }
  async function startAt(anchor: CommentAnchorInput) {
    open.value = true
    if (!canStart()) return
    try { await options.flush() } catch (e) { error.value = String(e); return }
    if (destroyed || options.artworkBusy.value || saving.value) return
    if (!editor.graph.getNode(anchor.slideId) || anchor.slideId !== active.value) { error.value = `The target ${surface} changed. Open its context menu again.`; return }
    if (anchor.kind === 'object') {
      if (!objectPointOnSlide(editor.graph, anchor.nodeId, anchor.slideId)) { error.value = `The clicked object no longer belongs to this ${surface}.`; return }
      editor.select([anchor.nodeId])
    } else editor.clearSelection()
    pointMode.value = false; focusedId.value = null
    draftAnchor.value = { ...anchor }
    draftId = crypto.randomUUID()
  }
  async function startPoint() {
    if (!canStart()) return
    try { await options.flush() } catch (e) { error.value = String(e); return }
    if (options.artworkBusy.value || saving.value) return
    open.value = true; focusedId.value = null; draftAnchor.value = null; pointMode.value = true
  }
  function placePoint(x: number, y: number) {
    if (!pointMode.value || options.artworkBusy.value || saving.value) return
    draftAnchor.value = { kind: 'point', slideId: active.value, x, y }
    pointMode.value = false; open.value = true; draftId = crypto.randomUUID()
  }
  async function startObject() {
    const nodeId = [...editor.state.selectedIds][0]
    if (!nodeId || !objectPointOnSlide(editor.graph, nodeId, active.value)) { error.value = `Select an object on the current ${surface} first.`; return }
    await startAt({ kind: 'object', slideId: active.value, nodeId })
  }
  function selectThread(thread: CommentThread) {
    if (options.artworkBusy.value || saving.value) return
    if (hasDraft.value && focusedId.value !== thread.id) { error.value = 'Post or cancel your draft before switching threads.'; open.value = true; return }
    pointMode.value = false; draftAnchor.value = null
    if (focusedId.value !== thread.id) replyId = crypto.randomUUID()
    open.value = true; focusedId.value = thread.id; error.value = ''
    if (thread.resolved) showResolved.value = true
    const resolved = attachment(thread)
    if (resolved.detached !== 'slide_deleted') {
      options.navigate(thread.anchor.slideId)
      if (!resolved.detached && thread.anchor.kind === 'object') editor.select([thread.anchor.nodeId!])
      if (resolved.point && !resolved.offSlide) options.reveal?.(resolved.point)
    }
  }
  async function mutation(fn: () => Promise<CommentThread>, done: (thread: CommentThread) => void) {
    if (saving.value || options.artworkBusy.value) return
    saving.value = true; loading.value = false; ++requestGeneration; error.value = ''
    try {
      const thread = await fn()
      if (!destroyed) { ++requestGeneration; upsert(thread); done(thread) }
    } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
    finally { saving.value = false; loading.value = false }
  }
  async function post() {
    if (!draftAnchor.value || !draftBody.value.trim()) return
    const anchor = { ...draftAnchor.value }, body = draftBody.value.trim()
    await mutation(async () => {
      await options.flush()
      return api(commentsBase, { method: 'POST', body: JSON.stringify({ id: draftId, anchor, body, expectedRevision: options.revision.value }) })
    }, thread => { cancelDraft(); focusedId.value = thread.id })
  }
  async function reply() {
    const thread = focused.value
    if (!thread || !replyBody.value.trim()) return
    await mutation(() => api(`${commentsBase}/${thread.id}/replies`, {
      method: 'POST', body: JSON.stringify({ id: replyId, expectedVersion: thread.version, body: replyBody.value.trim() }),
    }), () => { replyBody.value = ''; replyId = crypto.randomUUID() })
  }
  async function setResolved(thread: CommentThread, resolved: boolean) {
    if (hasDraft.value) { error.value = 'Post or cancel your draft before resolving or reopening a thread.'; return }
    await mutation(() => api(`${commentsBase}/${thread.id}`, {
      method: 'PATCH', body: JSON.stringify({ expectedVersion: thread.version, resolved }),
    }), () => { if (resolved && !showResolved.value) focusedId.value = null })
  }
  async function ask(thread: CommentThread) {
    if (options.artworkBusy.value || saving.value || pointMode.value || thread.resolved) return
    if (hasDraft.value) { error.value = 'Post or cancel your draft before asking Claude.'; return }
    if (attachment(thread).detached === 'slide_deleted') { error.value = `The referenced ${surface} was deleted. This thread stays available for reference.`; return }
    try { await options.flush() } catch (e) { error.value = String(e); return }
    if (!await reload()) return
    const current = threads.value.find(t => t.id === thread.id)
    if (!current || current.resolved || attachment(current).detached === 'slide_deleted') { error.value = 'The comment changed. Refresh and review it before asking Claude.'; return }
    selectThread(current)
    await options.handoff({
      commentThreadId: current.id, expectedCommentVersion: current.version,
      message: `Please address comment #${number(current.id)} on "${slideTitle(current)}":\n${current.messages[0]!.body}`,
    })
  }
  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape' && pointMode.value) {
      event.preventDefault(); pointMode.value = false
      if (event.target instanceof Element) event.target.closest('.viewport')?.querySelector('canvas')?.focus()
    }
  }
  watch(active, () => { pointMode.value = false })
  watch(open, value => { if (!value) pointMode.value = false })
  watch(options.artworkBusy, value => { if (value) pointMode.value = false })
  onMounted(() => { void reload(); window.addEventListener('keydown', escape, true) })
  onUnmounted(() => { destroyed = true; ++requestGeneration; window.removeEventListener('keydown', escape, true) })
  return { surface, threads, open, loading, loaded, saving, pointMode, showResolved, error, focusedId, focused, draftAnchor, draftBody, replyBody, hasDraft, visible, unresolvedCount, pins, draftPin, canAttach, number, attachment, locationLabel, slideTitle, reload, startPoint, placePoint, startObject, startAt, cancelDraft, cancelReply, selectThread, post, reply, setResolved, ask }
}
export type CommentsController = ReturnType<typeof useComments>
