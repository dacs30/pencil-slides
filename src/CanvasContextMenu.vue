<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Editor } from '@open-pencil/core/editor'
import type { CommentAnchorInput } from '../shared/comments'
import { clampContextMenu, keyboardCommentAnchor, pointerCommentAnchor } from './canvas-context'
import { objectPointOnSlide, slidePointToViewport, type Point } from './comment-geometry'

const props = defineProps<{ host?: HTMLElement; editor: Editor; frameId: string; blocked: boolean; commentsReady: boolean; commentsLoading: boolean }>()
const emit = defineEmits<{ addComment: [anchor: CommentAnchorInput]; openChange: [open: boolean] }>()
const open = ref(false)
const anchor = ref<CommentAnchorInput | null>(null)
const position = ref<Point>({ x: 8, y: 8 })
const menu = ref<HTMLElement>()
const item = ref<HTMLButtonElement>()
let returnFocus: HTMLElement | null = null
let disposed = false
const disabled = computed(() => props.blocked || !props.commentsReady || !anchor.value)
const targetLabel = computed(() => {
  if (props.blocked) return 'Finish the current editor action first'
  if (!props.commentsReady) return props.commentsLoading ? 'Comments are loading…' : 'Comments unavailable · open Comments to retry'
  if (!anchor.value) return 'Right-click inside a slide'
  if (anchor.value.kind === 'object') return `On ${props.editor.graph.getNode(anchor.value.nodeId)?.name ?? 'this object'}`
  return `At ${Math.round(anchor.value.x)}, ${Math.round(anchor.value.y)} on this slide`
})
function canvas() { return props.host?.querySelector('canvas') }
function isCanvasTarget(target: EventTarget | null) { return target === props.host || target === canvas() }
function close(restore = true) {
  if (!open.value) return
  open.value = false
  emit('openChange', false)
  if (restore) void nextTick(() => { if (!disposed && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }) })
}
async function show(target: CommentAnchorInput | null, point: Point) {
  const active = document.activeElement
  returnFocus = active instanceof HTMLElement && (active === canvas() || active.matches('textarea[aria-hidden="true"]')) ? active : canvas() ?? null
  anchor.value = target
  position.value = clampContextMenu(point, { width: 230, height: 90 }, { width: innerWidth, height: innerHeight })
  open.value = true
  emit('openChange', true)
  await nextTick()
  if (!open.value || disposed) return
  const bounds = menu.value?.getBoundingClientRect()
  if (bounds) position.value = clampContextMenu(point, bounds, { width: innerWidth, height: innerHeight })
  if (!disabled.value) item.value?.focus()
  else menu.value?.focus()
}
function pointerMenu(event: MouseEvent) {
  if (!isCanvasTarget(event.target)) return
  event.preventDefault()
  event.stopPropagation()
  const rect = canvas()?.getBoundingClientRect()
  if (!rect) return
  const point = { x: event.clientX, y: event.clientY }
  void show(pointerCommentAnchor(props.editor.graph, props.frameId, point, rect, props.editor.state), point)
}
function guardSecondaryInput(event: MouseEvent) {
  const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey && /Mac/.test(navigator.platform))
  if (secondary && isCanvasTarget(event.target)) {
    // useCanvasInput has no mounted context menu; intercept before its drawing/dragging handlers.
    event.stopPropagation()
    if (event.type === 'mousedown') event.preventDefault()
  }
}
function keyboardTrigger(event: KeyboardEvent) {
  if (!isCanvasTarget(event.target) || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return
  event.preventDefault()
  event.stopPropagation()
  const target = keyboardCommentAnchor(props.editor.graph, props.frameId, props.editor.state.selectedIds)
  const rect = canvas()?.getBoundingClientRect()
  if (!rect) return
  const local = target?.kind === 'object' ? objectPointOnSlide(props.editor.graph, target.nodeId, target.slideId) : target
  const point = local ? slidePointToViewport(props.editor.graph, props.frameId, local, props.editor.state) : null
  void show(target, point ? { x: rect.left + point.x, y: rect.top + point.y } : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
}
function addComment() {
  if (disabled.value || !anchor.value) return
  const target = { ...anchor.value }
  close(false)
  emit('addComment', target)
}
function menuKeys(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    if (!disabled.value) item.value?.focus()
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target === menu.value) { event.preventDefault(); addComment() }
}
function outside(event: Event) {
  if (open.value && event.target instanceof Node && !menu.value?.contains(event.target)) close(false)
}
function escape(event: KeyboardEvent) {
  if (open.value && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
}
function resized() { close() }
watch(() => props.host, (host, _previous, cleanup) => {
  if (!host) return
  host.addEventListener('contextmenu', pointerMenu)
  host.addEventListener('pointerdown', guardSecondaryInput, true)
  host.addEventListener('mousedown', guardSecondaryInput, true)
  host.addEventListener('keydown', keyboardTrigger, true)
  cleanup(() => {
    host.removeEventListener('contextmenu', pointerMenu)
    host.removeEventListener('pointerdown', guardSecondaryInput, true)
    host.removeEventListener('mousedown', guardSecondaryInput, true)
    host.removeEventListener('keydown', keyboardTrigger, true)
  })
}, { immediate: true })
watch(() => [props.frameId, props.editor.state.panX, props.editor.state.panY, props.editor.state.zoom, props.editor.state.sceneVersion], () => close())
watch(() => props.blocked, value => { if (value) close() })
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('contextmenu', outside, true)
  document.addEventListener('keydown', escape, true)
  window.addEventListener('resize', resized)
})
onUnmounted(() => {
  disposed = true
  emit('openChange', false)
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('contextmenu', outside, true)
  document.removeEventListener('keydown', escape, true)
  window.removeEventListener('resize', resized)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="menu" class="canvas-context-menu" role="menu" tabindex="-1" aria-label="Canvas actions"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }" @keydown.stop="menuKeys" @contextmenu.prevent>
      <div class="canvas-context-target" role="presentation">{{ targetLabel }}</div>
      <button ref="item" type="button" role="menuitem" :disabled="disabled" @click="addComment"><span aria-hidden="true">◯</span>Add comment</button>
    </div>
  </Teleport>
</template>
