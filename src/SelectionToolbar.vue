<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import type { Editor } from '@open-pencil/core/editor'
import type { SceneNode, Color } from '@open-pencil/scene-graph'
import { elementProps, type ElementProperties } from '../shared/model'
import { placeSelectionToolbar, selectionViewportBounds, textAttributeValues, textToggleState } from './selection-toolbar'

const props = defineProps<{
  editor: Editor; node: SceneNode; version: number; host?: HTMLElement
  hidden: boolean; disabled: boolean; commentsReady: boolean
}>()
const emit = defineEmits<{ format: [id: string, changes: ElementProperties]; comment: [id: string]; properties: [id: string]; dismiss: [] }>()
const toolbar = ref<HTMLElement>()
const size = ref({ width: 360, height: 36 })
const viewport = ref({ width: 0, height: 0, offsetX: 0, offsetY: 0 })
const validation = ref('')
type NumericField = 'fontSize' | 'width' | 'height' | 'cornerRadius' | 'strokeWidth'
const drafts = reactive<Partial<Record<NumericField, string>>>({})
let cancelled = false
let focusBeforeSave: HTMLElement | null = null
let hostObserver: ResizeObserver | undefined
let toolbarObserver: ResizeObserver | undefined
function hex(color: Color | undefined, fallback = '#34332f') {
  return color ? '#' + [color.r, color.g, color.b].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('') : fallback
}
const text = computed(() => props.node.type === 'TEXT')
const display = computed(() => {
  props.version
  const n = props.node
  const fontSizes = text.value ? textAttributeValues(n, 'fontSize') : []
  return {
    color: hex(n.fills.find(f => f.visible)?.color, '#ffffff'),
    stroke: hex(n.strokes[0]?.color),
    strokeWidth: n.strokes[0]?.weight ?? 0,
    fontSize: fontSizes.length === 1 ? fontSizes[0] : '',
    bold: textToggleState(n, 'bold'),
    italic: textToggleState(n, 'italic'),
    underline: textToggleState(n, 'underline'),
    corner: n.independentCorners ? '' : n.cornerRadius,
  }
})
const position = computed(() => {
  props.version
  return placeSelectionToolbar(selectionViewportBounds(props.editor.graph, props.node, props.editor.state), viewport.value, size.value)
})
const visible = computed(() => !props.hidden && Boolean(position.value))
function format(changes: ElementProperties) {
  if (cancelled || props.hidden) return
  const pending: ElementProperties = {}
  for (const [key, value] of Object.entries(drafts)) {
    if (!value.trim()) { validation.value = 'Enter a value within the allowed range.'; return }
    pending[key as NumericField] = Number(value)
  }
  const parsed = elementProps.safeParse({ ...pending, ...changes })
  if (!parsed.success) { validation.value = 'Enter a value within the allowed range.'; return }
  validation.value = ''
  emit('format', props.node.id, parsed.data)
}
function inputDraft(key: NumericField, event: Event) { drafts[key] = (event.target as HTMLInputElement).value }
function number(key: NumericField, event: Event) {
  const input = event.target as HTMLInputElement
  if (input.dataset.current !== '' && Number(input.value) === Number(input.dataset.current)) { delete drafts[key]; return }
  if (!input.value.trim() || !input.validity.valid) {
    validation.value = 'Enter a value within the allowed range.'
    return
  }
  format({ [key]: Number(input.value) })
}
function color(key: 'fill' | 'stroke', event: Event) { format({ [key]: (event.target as HTMLInputElement).value }) }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault(); cancelled = true; emit('dismiss'); return
  }
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
    event.preventDefault()
    event.target.blur()
    return
  }
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target instanceof HTMLButtonElement) {
    const controls = [...(toolbar.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? [])]
    const index = controls.indexOf(event.target)
    if (controls.length && index >= 0) { event.preventDefault(); controls[(index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length]?.focus() }
  }
}
watch(() => props.host, host => {
  hostObserver?.disconnect()
  if (!host) return
  const measure = () => {
    const canvas = host.querySelector('canvas')
    if (!canvas) return
    const rect = canvas.getBoundingClientRect(), parent = host.getBoundingClientRect()
    viewport.value = { width: rect.width, height: rect.height, offsetX: rect.left - parent.left, offsetY: rect.top - parent.top }
  }
  hostObserver = new ResizeObserver(measure)
  hostObserver.observe(host)
  measure()
}, { immediate: true })
watch(toolbar, element => {
  toolbarObserver?.disconnect()
  if (!element) return
  toolbarObserver = new ResizeObserver(() => { size.value = { width: element.offsetWidth, height: element.offsetHeight } })
  toolbarObserver.observe(element)
})
watch(() => props.disabled, async disabled => {
  if (disabled) focusBeforeSave = toolbar.value?.contains(document.activeElement) ? document.activeElement as HTMLElement : null
  else {
    await nextTick()
    if (focusBeforeSave?.isConnected && document.activeElement === document.body) focusBeforeSave.focus({ preventScroll: true })
  }
})
watch(() => [props.version, props.disabled], () => {
  if (props.disabled) return
  const values = { fontSize: display.value.fontSize, width: props.node.width, height: props.node.height, cornerRadius: display.value.corner, strokeWidth: display.value.strokeWidth }
  for (const key of Object.keys(drafts) as NumericField[]) {
    if (drafts[key]?.trim() && values[key] !== '' && Number(drafts[key]) === Number(values[key])) delete drafts[key]
  }
})
onUnmounted(() => { hostObserver?.disconnect(); toolbarObserver?.disconnect() })
</script>

<template>
  <div v-if="visible && position" ref="toolbar" class="selection-toolbar" :class="{ 'shape-formatting': !text }" role="toolbar"
    :aria-label="text ? 'Text formatting' : 'Shape formatting'" :data-placement="position.side"
    :style="{ left: `${position.x + viewport.offsetX}px`, top: `${position.y + viewport.offsetY}px`, maxWidth: `${Math.max(24, viewport.width - 16)}px` }"
    @pointerdown.stop @mousedown.stop @click.stop @keydown.stop="keydown" @contextmenu.stop>
    <template v-if="text">
      <input class="selection-number font-size-input" type="number" aria-label="Selection font size" data-format-key="fontSize" :data-current="display.fontSize" :title="`${node.fontFamily} · Font size for the whole text object`"
        min="6" max="400" step="any" :placeholder="display.fontSize === '' ? 'Mixed' : undefined" :value="drafts.fontSize ?? display.fontSize" :disabled="disabled" @input="inputDraft('fontSize', $event)" @change="number('fontSize', $event)">
      <label class="selection-color" title="Text color" :style="{ '--selection-color': display.color }"><span aria-hidden="true">A</span><input type="color" aria-label="Text color" :value="display.color" :disabled="disabled" @change="color('fill', $event)"></label>
      <span class="selection-divider" />
      <button type="button" class="format-bold" aria-label="Bold" :aria-pressed="display.bold" :class="{ active: display.bold === true, mixed: display.bold === 'mixed' }" :disabled="disabled" @click="format({ fontWeight: display.bold === true ? 400 : 700 })">B</button>
      <button type="button" class="format-italic" aria-label="Italic" :aria-pressed="display.italic" :class="{ active: display.italic === true, mixed: display.italic === 'mixed' }" :disabled="disabled" @click="format({ italic: display.italic !== true })">I</button>
      <button type="button" class="format-underline" aria-label="Underline" :aria-pressed="display.underline" :class="{ active: display.underline === true, mixed: display.underline === 'mixed' }" :disabled="disabled" @click="format({ textDecoration: display.underline === true ? 'NONE' : 'UNDERLINE' })">U</button>
      <span class="selection-divider" />
      <select aria-label="Text alignment" :value="node.textAlignHorizontal" :disabled="disabled" @change="format({ textAlignHorizontal: ($event.target as HTMLSelectElement).value as SceneNode['textAlignHorizontal'] })">
        <option value="LEFT">Left</option><option value="CENTER">Center</option><option value="RIGHT">Right</option><option value="JUSTIFIED">Justify</option>
      </select>
    </template>
    <template v-else>
      <label class="selection-color" title="Shape fill" :style="{ '--selection-color': display.color }"><span aria-hidden="true">▧</span><input type="color" aria-label="Shape fill" :value="display.color" :disabled="disabled" @change="color('fill', $event)"></label>
      <template v-if="node.strokes.length <= 1">
        <label class="selection-color" title="Outline color" :style="{ '--selection-color': display.stroke }"><span aria-hidden="true">□</span><input type="color" aria-label="Outline color" :value="display.stroke" :disabled="disabled" @change="color('stroke', $event)"></label>
        <label class="selection-size" title="Outline width · 0 removes it"><span aria-hidden="true">↔</span><input class="selection-number" type="number" aria-label="Outline width" data-format-key="strokeWidth" :data-current="display.strokeWidth" min="0" max="40" step="any" :value="drafts.strokeWidth ?? display.strokeWidth" :disabled="disabled" @input="inputDraft('strokeWidth', $event)" @change="number('strokeWidth', $event)"></label>
      </template>
      <span class="selection-divider" />
      <label class="selection-size"><span aria-hidden="true">W</span><input class="selection-number" type="number" aria-label="Selection width" data-format-key="width" :data-current="node.width" min="1" max="10000" step="any" :value="drafts.width ?? node.width" :disabled="disabled" @input="inputDraft('width', $event)" @change="number('width', $event)"></label>
      <label class="selection-size"><span aria-hidden="true">H</span><input class="selection-number" type="number" aria-label="Selection height" data-format-key="height" :data-current="node.height" min="1" max="10000" step="any" :value="drafts.height ?? node.height" :disabled="disabled" @input="inputDraft('height', $event)" @change="number('height', $event)"></label>
      <label v-if="node.type === 'RECTANGLE'" class="selection-size" title="Uniform corner radius"><span aria-hidden="true">⌜</span><input class="selection-number" type="number" aria-label="Corner radius" data-format-key="cornerRadius" :data-current="display.corner" min="0" max="500" step="any" :placeholder="display.corner === '' ? 'Mixed' : undefined" :value="drafts.cornerRadius ?? display.corner" :disabled="disabled" @input="inputDraft('cornerRadius', $event)" @change="number('cornerRadius', $event)"></label>
    </template>
    <span class="selection-divider" />
    <button type="button" aria-label="Comment on selected object" title="Add comment" :disabled="disabled || !commentsReady" @click="emit('comment', node.id)">◯</button>
    <button type="button" aria-label="Selection properties" title="Properties" :disabled="disabled" @click="emit('properties', node.id)">☷</button>
    <span v-if="validation" class="selection-validation" role="alert">{{ validation }}</span>
  </div>
</template>
