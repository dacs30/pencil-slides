<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { SceneGraph } from '@open-pencil/scene-graph'
import { screenToSlidePoint, slidePointToViewport, type CommentView, type Point } from './comment-geometry'

const props = defineProps<{
  graph: SceneGraph; slideId: string; view: CommentView; pointMode: boolean; disabled: boolean
  focusedId: string | null; draftPin: Point | null; canvasRect: () => DOMRect | undefined
  pins: { id: string; number: number; position: Point; detached: boolean; resolved: boolean; body: string }[]
}>()
const emit = defineEmits<{ select: [id: string]; place: [x: number, y: number]; cancel: []; error: [message: string] }>()
const picker = ref<HTMLElement>()
const keyboardPoint = ref<Point>({ x: 960, y: 540 })
const preview = computed(() => slidePointToViewport(props.graph, props.slideId, keyboardPoint.value, props.view))
watch(() => props.pointMode, async enabled => {
  if (enabled) { keyboardPoint.value = { x: 960, y: 540 }; await nextTick(); picker.value?.focus() }
}, { immediate: true })
function place(event: MouseEvent) {
  const rect = props.canvasRect()
  if (!rect) return emit('error', 'Canvas bounds are unavailable. Try again when the canvas is ready.')
  const point = screenToSlidePoint(props.graph, props.slideId, { x: event.clientX, y: event.clientY }, rect, props.view)
  if (!point) return emit('error', 'Choose a point inside the slide.')
  emit('place', point.x, point.y)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('cancel'); return }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault(); emit('place', keyboardPoint.value.x, keyboardPoint.value.y); return
  }
  const delta = event.shiftKey ? 100 : 20
  const steps: Record<string, Point> = { ArrowLeft: { x: -delta, y: 0 }, ArrowRight: { x: delta, y: 0 }, ArrowUp: { x: 0, y: -delta }, ArrowDown: { x: 0, y: delta } }
  const step = steps[event.key]
  if (step) {
    event.preventDefault()
    keyboardPoint.value = { x: Math.max(0, Math.min(1920, keyboardPoint.value.x + step.x)), y: Math.max(0, Math.min(1080, keyboardPoint.value.y + step.y)) }
  }
}
</script>

<template>
  <div class="comment-overlay" aria-label="Comment pins">
    <template v-if="!pointMode">
      <button v-for="pin in pins" :key="pin.id" type="button" class="comment-pin" :class="{ detached: pin.detached, resolved: pin.resolved, focused: focusedId === pin.id }"
        :style="{ left: `${pin.position.x}px`, top: `${pin.position.y}px` }" :disabled="disabled"
        :aria-label="`Comment ${pin.number}${pin.detached ? ', detached' : ''}${pin.resolved ? ', resolved' : ''}: ${pin.body.slice(0, 90)}`"
        :title="pin.body.slice(0, 200)" @pointerdown.stop @click.stop="emit('select', pin.id)">{{ pin.number }}</button>
      <span v-if="draftPin" class="comment-pin draft-pin" :style="{ left: `${draftPin.x}px`, top: `${draftPin.y}px` }" aria-hidden="true">+</span>
    </template>
    <div v-else ref="picker" class="comment-point-picker" role="button" tabindex="0" aria-label="Place a comment on the slide" aria-describedby="comment-mode-instructions"
      @pointerdown.stop.prevent @pointerup.stop @click.stop.prevent="place" @dblclick.stop.prevent @wheel.stop.prevent @keydown.stop="keydown">
      <span v-if="preview" class="comment-pin draft-pin" :style="{ left: `${preview.x}px`, top: `${preview.y}px` }" aria-hidden="true">+</span>
    </div>
  </div>
</template>
