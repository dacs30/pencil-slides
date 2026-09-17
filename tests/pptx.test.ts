import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unzipSync, strFromU8 } from 'fflate'
import { SceneGraph } from '@open-pencil/scene-graph'
import { fill } from '../src/document.js'
import { createPowerPoint, planPowerPoint, type PowerPointDeck } from '../src/pptx-export.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
function fixture() {
  const graph = new SceneGraph()
  const pageId = graph.getPages()[0]!.id
  graph.createNode('FRAME', pageId, { id: 'first', name: 'First frame', x: 9000, width: 1920, height: 1080, clipsContent: true, fills: fill('#f8f5ef') })
  graph.createNode('FRAME', pageId, { id: 'second', name: 'Second frame', x: 4000, width: 1920, height: 1080, clipsContent: true, fills: fill('#ffffff') })
  graph.createNode('TEXT', 'first', {
    id: 'headline', name: 'Headline', x: 144, y: 288, width: 576, height: 144,
    text: 'Editable & aligned\nSecond line', fontSize: 96, fontFamily: 'Inter', fontWeight: 700,
    italic: true, textAlignHorizontal: 'CENTER', textAlignVertical: 'BOTTOM', lineHeight: 100, letterSpacing: 4,
    fills: fill('#123456'),
  })
  graph.createNode('RECTANGLE', 'first', { id: 'transparent', name: 'Transparent rectangle', x: 50, y: 50, width: 120, height: 80, fills: [] })
  graph.createNode('TEXT', 'first', { id: 'hidden', name: 'Hidden', visible: false, text: 'Do not export hidden text' })
  graph.createNode('ELLIPSE', 'second', {
    id: 'ellipse', name: 'Editable ellipse', x: 144, y: 144, width: 288, height: 144, rotation: 30,
    fills: fill('#ab3456').map(f => ({ ...f, opacity: 0.5 })), opacity: 0.5,
    strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, weight: 4, align: 'CENTER', visible: true }],
  })
  const deck: PowerPointDeck = { title: 'Editable deck', pageId, slides: [{ id: 'second', title: 'First in deck' }, { id: 'first', title: 'Second & final' }] }
  return { graph, deck }
}
function xmlFiles(bytes: Uint8Array) {
  const zip = unzipSync(bytes)
  return { zip, xml: (name: string) => strFromU8(zip[name]!) }
}
function namedShape(xml: string, name: string) {
  const shape = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(m => m[0]).find(s => s.includes(`name="${name}"`))
  assert.ok(shape, `Expected editable shape ${name}`)
  return shape
}

test('PPTX ZIP contains ordered 16:9 slides with editable geometry, typography, alpha and notes', async () => {
  const { graph, deck } = fixture()
  let rasterCalls = 0
  const progress: number[] = []
  const result = await createPowerPoint(graph, deck, { renderSlide: async () => { rasterCalls++; return PNG }, onProgress: done => progress.push(done) })
  assert.equal(rasterCalls, 0)
  assert.deepEqual(result.fonts, ['Inter'])
  assert.deepEqual(result.report.map(r => r.mode), ['editable', 'editable'])
  assert.deepEqual(progress, [0, 1, 2])
  const { zip, xml } = xmlFiles(result.bytes)
  assert.equal(Object.keys(zip).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length, 2)
  assert.match(xml('ppt/presentation.xml'), /<p:sldSz cx="12192000" cy="6858000"/)
  assert.match(xml('docProps/core.xml'), /Editable deck/)
  assert.match(xml('ppt/notesSlides/notesSlide1.xml'), /First in deck/)
  assert.match(xml('ppt/notesSlides/notesSlide2.xml'), /Second &amp; final/)
  const first = xml('ppt/slides/slide1.xml'), second = xml('ppt/slides/slide2.xml')
  assert.doesNotMatch(first + second, /<p:pic>/)
  assert.doesNotMatch(first + second, /Do not export hidden text/)
  const ellipse = namedShape(first, 'Editable ellipse')
  assert.match(ellipse, /prst="ellipse"/)
  assert.match(ellipse, /rot="1800000"/)
  assert.match(ellipse, /<a:off x="914400" y="914400"/)
  assert.match(ellipse, /<a:ext cx="1828800" cy="914400"/)
  assert.match(ellipse, /<a:srgbClr val="AB3456"><a:alpha val="25000"/)
  assert.match(ellipse, /<a:ln w="25400"/)
  const text = namedShape(second, 'Headline')
  assert.match(text, /Editable &amp; aligned/)
  assert.match(text, /Second line/)
  assert.match(text, /<a:off x="914400" y="1828800"/)
  assert.match(text, /<a:ext cx="3657600" cy="914400"/)
  assert.match(text, /sz="4800"/)
  assert.match(text, /b="1"/)
  assert.match(text, /i="1"/)
  assert.match(text, /typeface="Inter"/)
  assert.match(text, /algn="ctr"/)
  assert.match(text, /anchor="b"/)
  assert.match(text, /<a:spcPts val="5000"/)
  assert.match(text, /spc="200"/)
  assert.match(text, /lIns="0"/)
  assert.match(text, /val="123456"/)
  const transparent = namedShape(second, 'Transparent rectangle')
  assert.match(transparent, /prst="rect"/)
  assert.match(transparent, /<a:alpha val="0"/)
  assert.ok(second.indexOf('name="Headline"') < second.indexOf('name="Transparent rectangle"'), 'Keep graph stacking order')
})

test('unsupported nested content rasterizes its entire slide and reports why, without dropping or duplicating it', async () => {
  const { graph, deck } = fixture()
  graph.createNode('GROUP', 'first', { id: 'group', name: 'Nested group', x: 100, y: 100 })
  graph.createNode('RECTANGLE', 'group', { id: 'nested', name: 'Nested rectangle', x: 80, y: 70, fills: fill('#cc0022') })
  const rendered: string[] = []
  const result = await createPowerPoint(graph, deck, { renderSlide: async id => { rendered.push(id); return PNG } })
  assert.deepEqual(rendered, ['first'])
  assert.equal(result.report[1]!.mode, 'image')
  assert.match(result.report[1]!.reasons.join(), /grouped.*group/)
  const { zip, xml } = xmlFiles(result.bytes)
  const fallback = xml('ppt/slides/slide2.xml')
  assert.equal((fallback.match(/<p:pic>/g) ?? []).length, 1)
  assert.doesNotMatch(fallback, /<p:sp>|Editable &amp; aligned/)
  assert.match(fallback, /<a:off x="0" y="0"/)
  assert.match(fallback, /<a:ext cx="12192000" cy="6858000"/)
  assert.match(xml('ppt/notesSlides/notesSlide2.xml'), /Rendered image/)
  assert.ok(Object.keys(zip).some(f => /^ppt\/media\/.*\.png$/.test(f)))
})

test('complex paint, missing fonts, clipped text, and unsupported font weights explicitly trigger image fallback', () => {
  for (const kind of ['gradient', 'rich-text', 'missing-font', 'overflow-text', 'weight', 'clipped-shape']) {
    const { graph, deck } = fixture()
    const n = graph.getNode('headline')!
    if (kind === 'gradient') n.fills[0]!.type = 'GRADIENT_LINEAR'
    if (kind === 'rich-text') n.styleRuns = [{ start: 0, length: 5, style: { fontWeight: 700 } }]
    if (kind === 'weight') n.fontWeight = 500
    if (kind === 'clipped-shape') graph.updateNode('transparent', { x: -40 })
    const report = planPowerPoint(graph, deck, {
      renderSlide: async () => PNG,
      textIssue: node => node.id === 'headline' && ['missing-font', 'overflow-text'].includes(kind) ? kind : null,
    })
    assert.equal(report[1]!.mode, 'image', kind)
    assert.ok(report[1]!.reasons.length, kind)
  }
})

test('exact appearance mode makes every slide an image and preserves title/order in notes', async () => {
  const { graph, deck } = fixture()
  const order: string[] = []
  const result = await createPowerPoint(graph, deck, { mode: 'appearance', renderSlide: async id => { order.push(id); return PNG } })
  assert.deepEqual(order, ['second', 'first'])
  assert.deepEqual(result.fonts, [])
  const { xml } = xmlFiles(result.bytes)
  for (const i of [1, 2]) {
    assert.match(xml(`ppt/slides/slide${i}.xml`), /<p:pic>/)
    assert.doesNotMatch(xml(`ppt/slides/slide${i}.xml`), /<p:sp>/)
    assert.match(xml(`ppt/notesSlides/notesSlide${i}.xml`), /Exact appearance mode/)
  }
})

test('empty decks, missing descendants, and failed fallback rendering abort rather than exporting partial decks', async () => {
  const { graph, deck } = fixture()
  await assert.rejects(createPowerPoint(graph, { ...deck, slides: [] }, { renderSlide: async () => PNG }), /no slides/)
  await assert.rejects(createPowerPoint(graph, deck, { mode: 'appearance', renderSlide: async () => { throw new Error('Renderer unavailable') } }), /Renderer unavailable/)
  await assert.rejects(createPowerPoint(graph, deck, { mode: 'appearance', renderSlide: async () => '' }), /No PowerPoint file/)
  graph.getNode('first')!.childIds.push('missing')
  await assert.rejects(createPowerPoint(graph, deck, { renderSlide: async () => PNG }), /Missing or inconsistent/)
})
