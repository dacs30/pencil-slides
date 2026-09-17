import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SceneGraph } from '@open-pencil/scene-graph'
import { fill } from '../src/document.js'
import { clampContextMenu, keyboardCommentAnchor, pointerCommentAnchor } from '../src/canvas-context.js'
import { slidePointToViewport } from '../src/comment-geometry.js'

function fixture() {
  const graph = new SceneGraph()
  const page = graph.getPages()[0]!
  const slide = graph.createNode('FRAME', page.id, { x: 2120, y: 320, width: 1920, height: 1080, fills: fill('#ffffff'), clipsContent: true })
  const a = graph.createNode('RECTANGLE', slide.id, { name: 'Previously selected', x: 100, y: 100, width: 400, height: 200, fills: fill('#224466') })
  const b = graph.createNode('ELLIPSE', slide.id, { name: 'Clicked object', x: 900, y: 500, width: 300, height: 200, fills: fill('#bb7755') })
  return { graph, slide, a, b }
}

test('right-click hit testing targets the clicked object or exact slide point across pan/zoom without mutations', () => {
  const { graph, slide, a, b } = fixture()
  const before = structuredClone([...graph.nodes])
  const origin = { left: 431, top: 211 }
  for (const zoom of [0.25, 0.75, 1.8]) {
    const view = { panX: -slide.x * zoom + 65, panY: -slide.y * zoom + 30, zoom }
    const at = (x: number, y: number) => {
      const screen = slidePointToViewport(graph, slide.id, { x, y }, view)!
      return pointerCommentAnchor(graph, slide.id, { x: origin.left + screen.x, y: origin.top + screen.y }, origin, view)
    }
    assert.deepEqual(at(1050, 600), { kind: 'object', slideId: slide.id, nodeId: b.id })
    assert.deepEqual(at(250, 200), { kind: 'object', slideId: slide.id, nodeId: a.id })
    assert.deepEqual(at(1700, 950), { kind: 'point', slideId: slide.id, x: 1700, y: 950 })
    assert.equal(at(-5, 400), null)
    assert.equal(at(1950, 900), null)
  }
  assert.deepEqual([...graph.nodes], before)
})

test('keyboard menu targets active-slide selection, never a foreign/deleted selection, with center fallback', () => {
  const { graph, slide, a } = fixture()
  const other = graph.createNode('FRAME', graph.getPages()[0]!.id, { width: 1920, height: 1080 })
  const foreign = graph.createNode('RECTANGLE', other.id)
  assert.deepEqual(keyboardCommentAnchor(graph, slide.id, new Set([foreign.id, 'missing', a.id])), { kind: 'object', slideId: slide.id, nodeId: a.id })
  assert.deepEqual(keyboardCommentAnchor(graph, slide.id, new Set([foreign.id, 'missing'])), { kind: 'point', slideId: slide.id, x: 960, y: 540 })
  assert.equal(keyboardCommentAnchor(graph, 'missing-slide', []), null)
})

test('menu placement clamps near edges on desktop and mobile viewports', () => {
  const size = { width: 230, height: 90 }
  assert.deepEqual(clampContextMenu({ x: 990, y: 690 }, size, { width: 1000, height: 700 }), { x: 762, y: 602 })
  assert.deepEqual(clampContextMenu({ x: -20, y: -5 }, size, { width: 1000, height: 700 }), { x: 8, y: 8 })
  const mobile = clampContextMenu({ x: 389, y: 843 }, size, { width: 390, height: 844 })
  assert.ok(mobile.x >= 8 && mobile.y >= 8)
  assert.ok(mobile.x + size.width <= 382 && mobile.y + size.height <= 836)
})
