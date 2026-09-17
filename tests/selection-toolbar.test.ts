import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SceneGraph } from '@open-pencil/scene-graph'
import { createEditor, createDefaultEditorState } from '@open-pencil/core/editor'
import { sampleDeck, restore, snapshot, applyOperations, fill } from '../src/document.js'
import { elementProps } from '../shared/model.js'
import { toolbarSelection, selectionViewportBounds, placeSelectionToolbar, textToggleState, textAttributeValues } from '../src/selection-toolbar.js'
import { Store } from '../server/store.js'

test('floating toolbar only selects one supported object on the active slide without mutating artwork', () => {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]!
  const slide = graph.createNode('FRAME', page.id)
  const text = graph.createNode('TEXT', slide.id)
  const rect = graph.createNode('RECTANGLE', slide.id)
  const ellipse = graph.createNode('ELLIPSE', slide.id)
  const other = graph.createNode('FRAME', page.id)
  const foreign = graph.createNode('TEXT', other.id)
  const before = structuredClone([...graph.nodes])
  assert.equal(toolbarSelection(graph, [], slide.id), null)
  assert.equal(toolbarSelection(graph, [text.id, rect.id], slide.id), null)
  assert.equal(toolbarSelection(graph, [slide.id], slide.id), null)
  assert.equal(toolbarSelection(graph, ['missing'], slide.id), null)
  assert.equal(toolbarSelection(graph, [foreign.id], slide.id), null)
  for (const node of [text, rect, ellipse]) assert.equal(toolbarSelection(graph, [node.id], slide.id)?.type, node.type)
  assert.deepEqual([...graph.nodes], before)
  graph.updateNode(text.id, { visible: false })
  assert.equal(toolbarSelection(graph, [text.id], slide.id), null)
})

test('toolbar bounds follow SDK rotation/pan/zoom and placement flips/clamps at viewport edges', () => {
  const graph = new SceneGraph()
  const slide = graph.createNode('FRAME', graph.getPages()[0]!.id, { x: 2120, y: 0 })
  const node = graph.createNode('RECTANGLE', slide.id, { x: 100, y: 100, width: 200, height: 80, rotation: 90 })
  const bounds = selectionViewportBounds(graph, node, { zoom: 0.5, panX: -1000, panY: 50 })
  for (const [key, expected] of Object.entries({ left: 140, top: 70, right: 180, bottom: 170 })) assert.ok(Math.abs(bounds[key as keyof typeof bounds] - expected) < 0.001)
  const viewport = { width: 800, height: 600 }, toolbar = { width: 360, height: 36 }
  assert.deepEqual(placeSelectionToolbar({ left: 200, top: 300, right: 600, bottom: 400 }, viewport, toolbar), { x: 220, y: 240, side: 'above' })
  assert.deepEqual(placeSelectionToolbar({ left: 200, top: 4, right: 350, bottom: 40 }, viewport, toolbar), { x: 95, y: 64, side: 'below' })
  const edge = placeSelectionToolbar({ left: -50, top: -20, right: 40, bottom: 550 }, { width: 360, height: 300 }, toolbar)!
  assert.ok(edge.x >= 8 && edge.x + 344 <= 352 && edge.y >= 8 && edge.y + 36 <= 292)
  assert.equal(placeSelectionToolbar({ left: 900, top: 30, right: 1000, bottom: 100 }, viewport, toolbar), null)
})

test('text formatting updates requested rich-run attributes, preserves other styles, and round-trips through undo/save/reload', () => {
  const data = sampleDeck(), graph = new SceneGraph()
  restore(graph, data)
  const title = graph.getChildren(data.slides[0]!.id).find(n => n.type === 'TEXT')!
  graph.updateNode(title.id, { text: 'Hello world', fontSize: 80, styleRuns: [
    { start: 0, length: 5, style: { fontWeight: 400, fontFamily: 'Inter', fontSize: 30, fills: fill('#ff0000') } },
    { start: 6, length: 5, style: { fontWeight: 700, italic: true, textDecoration: 'STRIKETHROUGH' } },
  ] })
  assert.equal(textToggleState(title, 'bold'), 'mixed')
  assert.equal(textToggleState(title, 'italic'), 'mixed')
  assert.equal(textAttributeValues(title, 'fontSize').length, 2)
  const meta = { title: data.title, pageId: data.pageId, slides: structuredClone(data.slides) }
  const editor = createEditor({ graph, state: createDefaultEditorState(data.pageId) })
  const store = new Store(':memory:')
  try {
    const before = snapshot(graph, meta), deck = store.create(before)
    applyOperations(editor, meta, [{ op: 'update_element', id: title.id, props: { fontSize: 64, fontWeight: 700, italic: true, textDecoration: 'UNDERLINE', textAlignHorizontal: 'CENTER', fill: '#224466' } }])
    const after = snapshot(graph, meta)
    assert.equal(title.fontSize, 64)
    assert.equal(title.italic, true)
    assert.equal(title.textDecoration, 'UNDERLINE')
    assert.equal(title.textAlignHorizontal, 'CENTER')
    assert.equal(title.styleRuns[0]!.style.fontFamily, 'Inter')
    assert.ok(title.styleRuns.every(run => run.style.fontSize === 64 && run.style.fontWeight === 700 && run.style.italic && run.style.textDecoration === 'UNDERLINE'))
    assert.equal(textToggleState(title, 'bold'), true)
    assert.equal(textToggleState(title, 'underline'), true)
    editor.pushUndoEntry({ label: 'Format text', forward: () => restore(graph, after), inverse: () => restore(graph, before) })
    store.save(deck.id, 0, after, 'format-1')
    editor.undoAction()
    assert.deepEqual(snapshot(graph, meta), before)
    store.save(deck.id, 1, snapshot(graph, meta), 'format-undo')
    editor.redoAction()
    assert.deepEqual(snapshot(graph, meta), after)
    store.save(deck.id, 2, snapshot(graph, meta), 'format-redo')
    const reloaded = new SceneGraph()
    restore(reloaded, store.get(deck.id).snapshot)
    assert.equal(reloaded.getNode(title.id)!.italic, true)
    assert.deepEqual(reloaded.getNode(title.id)!.styleRuns, graph.getNode(title.id)!.styleRuns)
  } finally { editor.dispose(); store.close() }
})

test('shape fill/outline/radius changes use validated SDK properties and remove outlines explicitly at zero', () => {
  const data = sampleDeck(), graph = new SceneGraph()
  restore(graph, data)
  const editor = createEditor({ graph, state: createDefaultEditorState(data.pageId) })
  const meta = { title: data.title, pageId: data.pageId, slides: structuredClone(data.slides) }
  try {
    applyOperations(editor, meta, [{ op: 'create_element', id: 'shape', slideId: data.slides[0]!.id, type: 'RECTANGLE', props: { fill: '#112233', stroke: '#445566', strokeWidth: 4, cornerRadius: 20, width: 500, height: 250 } }])
    const node = graph.getNode('shape')!
    assert.equal(node.strokes[0]!.weight, 4)
    assert.equal(node.strokes[0]!.align, 'CENTER')
    assert.equal(node.cornerRadius, 20)
    assert.equal(node.width, 500)
    graph.updateNode(node.id, { opacity: 0.5, independentCorners: true, topLeftRadius: 15 })
    applyOperations(editor, meta, [{ op: 'update_element', id: node.id, props: { strokeWidth: 0, cornerRadius: 0 } }])
    assert.equal(node.strokes.length, 0)
    assert.equal(node.cornerRadius, 0)
    assert.equal(node.topLeftRadius, 0)
    assert.equal(node.independentCorners, false)
    assert.equal(node.opacity, 0.5)
    assert.throws(() => elementProps.parse({ strokeWidth: -1 }))
    assert.throws(() => elementProps.parse({ fontSize: 401 }))
    assert.throws(() => elementProps.parse({ italic: 'yes' }))
    assert.throws(() => elementProps.parse({ textAlignHorizontal: 'UP' }))
    assert.throws(() => elementProps.parse({ cornerRadius: 501 }))
  } finally { editor.dispose() }
})
