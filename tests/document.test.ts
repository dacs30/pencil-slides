import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SceneGraph } from '@open-pencil/scene-graph'
import { createDefaultEditorState, createEditor } from '@open-pencil/core/editor'
import { applyOperations, blankDeck, sampleDeck, restore, snapshot } from '../src/document.js'
import { batchSchema, snapshotSchema } from '../shared/model.js'

test('real OpenPencil graph survives snapshots, text/shapes, reorder and atomic undo', () => {
  const data = sampleDeck()
  const graph = new SceneGraph()
  restore(graph, data)
  assert.deepEqual(snapshot(graph, data), data)
  const editor = createEditor({ graph, state: createDefaultEditorState(data.pageId), getViewportSize: () => ({ width: 1000, height: 600 }) })
  const meta = { title: data.title, pageId: data.pageId, slides: structuredClone(data.slides) }
  const before = snapshot(graph, meta)
  applyOperations(editor, meta, [
    { op: 'create_slide', id: 'second', title: 'Second' },
    { op: 'create_element', id: 'heading', slideId: 'second', type: 'TEXT', props: { text: 'Actual SDK text', x: 50, y: 100, fontSize: 80 } },
    { op: 'create_element', id: 'circle', slideId: 'second', type: 'ELLIPSE', props: { fill: '#ff0000' } },
    { op: 'reorder_slides', ids: ['second', data.slides[0]!.id] },
  ])
  const after = snapshot(graph, meta)
  editor.pushUndoEntry({
    label: 'AI batch',
    forward: () => { restore(graph, after); meta.slides = structuredClone(after.slides) },
    inverse: () => { restore(graph, before); meta.slides = structuredClone(before.slides) },
  })
  assert.equal(graph.getNode('heading')!.text, 'Actual SDK text')
  assert.equal(meta.slides[0]!.id, 'second')
  editor.undoAction()
  assert.deepEqual(snapshot(graph, meta), before)
  editor.redoAction()
  assert.deepEqual(snapshot(graph, meta), after)
  const reloaded = new SceneGraph()
  restore(reloaded, after)
  assert.deepEqual(snapshot(reloaded, after), after)
  editor.dispose()
})

test('schemas reject unsafe tools, oversized batches and broken slide topology', () => {
  assert.throws(() => batchSchema.parse({ expectedRevision: 0, operations: [{ op: 'eval', code: 'bad' }] }))
  assert.throws(() => batchSchema.parse({ expectedRevision: -1, operations: [] }))
  const data = sampleDeck()
  data.nodes.find(n => n.type === 'FRAME')!.width = 100
  assert.throws(() => snapshotSchema.parse(data))
})

test('invalid operation can roll back without leaving a partial graph', () => {
  const before = sampleDeck()
  const graph = new SceneGraph()
  restore(graph, before)
  const editor = createEditor({ graph, state: createDefaultEditorState(before.pageId) })
  const meta = { title: before.title, pageId: before.pageId, slides: structuredClone(before.slides) }
  assert.throws(() => applyOperations(editor, meta, [
    { op: 'create_slide', id: 'partial', title: 'Must not remain' },
    { op: 'update_element', id: 'missing', props: { text: 'No' } },
  ]), /not found/)
  restore(graph, before)
  meta.slides = structuredClone(before.slides)
  assert.deepEqual(snapshot(graph, meta), before)
  editor.dispose()
})

test('restoration protects the document root from persisted SDK numeric ID collisions', () => {
  for (const collision of ['page', 'element']) {
    const data = sampleDeck()
    const graph = new SceneGraph()
    if (collision === 'page') {
      const old = data.pageId
      data.pageId = graph.rootId
      for (const n of data.nodes) if (n.parentId === old) n.parentId = data.pageId
    } else {
      const element = data.nodes.find(n => n.type === 'TEXT')!
      const old = element.id
      element.id = graph.rootId
      const frame = data.nodes.find(n => n.id === element.parentId)!
      frame.childIds = frame.childIds.map(id => id === old ? element.id : id)
    }
    restore(graph, data)
    assert.equal(graph.getPages()[0]!.id, data.pageId)
    assert.equal(snapshot(graph, data).nodes.length, data.nodes.length)
    assert.notEqual(graph.rootId, data.pageId)
  }
})

test('a new deck starts with one empty slide and no placeholder text', () => {
  const data = blankDeck()
  assert.equal(data.slides.length, 1)
  assert.deepEqual(data.nodes.map(n => n.type), ['FRAME'])
  assert.equal(data.nodes[0]!.childIds.length, 0)
  snapshotSchema.parse(data)
})
