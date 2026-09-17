<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useCanvas, useCanvasInput, useEditor, useTextEdit } from '@open-pencil/vue'

const props = defineProps<{ locked: boolean; frameId: string; label?: string }>()
const emit = defineEmits<{ ready: []; interaction: [active: boolean] }>()
const editor = useEditor()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const frameClip = computed(() => {
  editor.state.renderVersion
  const node = editor.graph.getNode(props.frameId)
  const canvas = canvasRef.value
  if (!node || !canvas) return undefined
  const { zoom, panX, panY } = editor.state
  const left = panX + node.x * zoom
  const top = panY + node.y * zoom
  // Clip only the displayed surface, never graph visibility or persisted slide contents.
  return `inset(${Math.max(0, top - 20)}px ${Math.max(0, canvas.clientWidth - left - node.width * zoom - 20)}px ${Math.max(0, canvas.clientHeight - top - node.height * zoom - 20)}px ${Math.max(0, left - 20)}px)`
})
const ctx = useCanvas(canvasRef, editor, { showRulers: false, onReady: () => emit('ready') })
const input = useCanvasInput(canvasRef, editor, ctx.hitTestSectionTitle, ctx.hitTestComponentLabel, ctx.hitTestFrameTitle, undefined, () => canvasRef.value?.focus(), () => !props.locked)
watch(() => Boolean(input.drag.value), value => emit('interaction', value), { immediate: true })
useTextEdit(canvasRef, editor, { isEnabled: () => !props.locked })
watch(() => props.locked, value => { if (value) input.cleanupInteractions() })
function keyboard(event: KeyboardEvent) {
  if (props.locked || editor.state.editingTextId || event.target !== canvasRef.value) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    event.shiftKey ? editor.redoAction() : editor.undoAction()
  }
  if (event.key === 'Escape') editor.clearSelection()
}
onMounted(() => window.addEventListener('keydown', keyboard))
onUnmounted(() => { emit('interaction', false); window.removeEventListener('keydown', keyboard) })
</script>

<template>
  <canvas ref="canvasRef" class="editor-canvas" :style="{ clipPath: frameClip }" tabindex="0" :aria-label="label ?? 'Editable slide canvas'" />
</template>
