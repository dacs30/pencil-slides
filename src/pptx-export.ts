import PptxGenJS from 'pptxgenjs'
import type { Color, Fill, SceneGraph, SceneNode } from '@open-pencil/scene-graph'

export const SLIDE_WIDTH_IN = 40 / 3
export const SLIDE_HEIGHT_IN = 7.5
const PX_PER_INCH = 144
const POINTS_PER_PX = 72 / PX_PER_INCH
const px = (value: number) => value / PX_PER_INCH
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const hex = (color: Color) => [color.r, color.g, color.b].map(v => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
const visiblePaint = (node: SceneNode) => node.fills.filter(f => f.visible)
const transparency = (alpha: number) => Math.round((1 - clamp(alpha)) * 100)

export type PowerPointMode = 'editable' | 'appearance'
export type SlideExportReport = { id: string; title: string; mode: 'editable' | 'image'; reasons: string[] }
export type PowerPointDeck = { title: string; pageId: string; slides: { id: string; title: string }[] }
export type PowerPointOptions = {
  mode?: PowerPointMode
  renderSlide: (id: string) => Promise<string>
  textIssue?: (node: SceneNode) => string | null
  onProgress?: (completed: number, total: number) => void
}

function validateDeck(graph: SceneGraph, deck: PowerPointDeck) {
  if (!deck.slides.length) throw new Error('There are no slides to export.')
  if (deck.slides.length > 100) throw new Error('PowerPoint export supports at most 100 slides.')
  const seen = new Set<string>()
  const walk = (id: string, parent: string) => {
    if (seen.has(id)) throw new Error(`Duplicate or cyclic node reference: ${id}`)
    seen.add(id)
    if (seen.size > 2000) throw new Error('PowerPoint export supports at most 2,000 nodes.')
    const n = graph.getNode(id)
    if (!n || n.parentId !== parent) throw new Error(`Missing or inconsistent node: ${id}`)
    if (![n.x, n.y, n.width, n.height, n.rotation, n.opacity].every(Number.isFinite) || n.width <= 0 || n.height <= 0) throw new Error(`Invalid geometry: ${n.name}`)
    for (const child of n.childIds) walk(child, id)
  }
  for (const slide of deck.slides) {
    const frame = graph.getNode(slide.id)
    if (!frame || frame.type !== 'FRAME' || frame.width !== 1920 || frame.height !== 1080) throw new Error(`Invalid slide frame: ${slide.title}`)
    walk(slide.id, deck.pageId)
  }
}

function commonIssue(node: SceneNode): string | null {
  if (node.isMask) return 'masks'
  if (!['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) return 'blend modes'
  if (node.effects.some(e => e.visible)) return 'shadows or effects'
  if (node.flipX || node.flipY) return 'flipped content'
  const fills = visiblePaint(node)
  if (fills.length > 1 || fills.some(f => f.type !== 'SOLID' || (f.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(f.blendMode)))) return 'complex fills'
  if (node.cornerRadius || node.topLeftRadius || node.topRightRadius || node.bottomLeftRadius || node.bottomRightRadius || node.cornerSmoothing) return 'rounded or smoothed corners'
  if (node.vectorNetwork || node.fillGeometry.length || node.strokeGeometry.length) return 'custom vector geometry'
  if (Object.keys(node.boundVariables).length) return 'variable-bound styling'
  return null
}

function outsideSlide(node: SceneNode): boolean {
  const angle = node.rotation * Math.PI / 180
  const halfWidth = (Math.abs(node.width * Math.cos(angle)) + Math.abs(node.height * Math.sin(angle))) / 2
  const halfHeight = (Math.abs(node.width * Math.sin(angle)) + Math.abs(node.height * Math.cos(angle))) / 2
  const border = Math.max(0, ...node.strokes.filter(s => s.visible).map(s => s.weight))
  const cx = node.x + node.width / 2, cy = node.y + node.height / 2
  return cx - halfWidth - border < 0 || cy - halfHeight - border < 0 || cx + halfWidth + border > 1920 || cy + halfHeight + border > 1080
}

function nodeIssue(node: SceneNode, options: PowerPointOptions): string | null {
  if (!['TEXT', 'RECTANGLE', 'ELLIPSE'].includes(node.type) || node.childIds.length) return `nested/grouped or unsupported ${node.type.toLowerCase()} content`
  const issue = commonIssue(node)
  if (issue) return issue
  if (outsideSlide(node)) return 'content clipped at a slide edge'
  const strokes = node.strokes.filter(s => s.visible)
  if (strokes.length > 1 || strokes.some(s => s.align !== 'CENTER' || s.dashPattern?.length) || node.independentStrokeWeights) return 'complex outlines'
  if (node.type === 'ELLIPSE' && node.arcData) return 'partial ellipses'
  if (node.type !== 'TEXT') return null
  if (strokes.length) return 'outlined text'
  if (node.styleRuns.length) return 'mixed text formatting'
  if (!node.fontFamily.trim() || !Number.isFinite(node.fontSize) || node.fontSize <= 0) return 'missing font information'
  if (![400, 700].includes(node.fontWeight)) return 'font weights other than regular or bold'
  if (node.fontFeatures.length || node.fontVariations.length || node.textPathData) return 'advanced typography'
  if (node.textCase !== 'ORIGINAL' || node.textDecorationStyle !== 'SOLID' || node.leadingTrim !== 'NONE') return 'advanced text appearance'
  if (node.textAutoResize === 'TRUNCATE' || node.maxLines !== null || node.textTruncation !== 'DISABLED') return 'truncated text'
  if (node.textDirection === 'RTL' || /[\u0590-\u08ff]/u.test(node.text)) return 'bidirectional text layout'
  return options.textIssue?.(node) ?? null
}

export function planPowerPoint(graph: SceneGraph, deck: PowerPointDeck, options: PowerPointOptions): SlideExportReport[] {
  validateDeck(graph, deck)
  return deck.slides.map(slide => {
    const frame = graph.getNode(slide.id)!
    const reasons: string[] = []
    if (options.mode === 'appearance') reasons.push('Exact appearance mode selected')
    const frameIssue = commonIssue(frame)
    if (frameIssue) reasons.push(`Slide background: ${frameIssue}`)
    if (!frame.visible || frame.opacity !== 1 || frame.rotation || frame.strokes.some(s => s.visible)) reasons.push('Slide-level visibility, opacity, rotation, or outline')
    for (const id of frame.childIds) {
      const node = graph.getNode(id)!
      if (!node.visible) continue
      const issue = nodeIssue(node, options)
      if (issue) reasons.push(`${node.name}: ${issue}`)
    }
    return { ...slide, mode: reasons.length ? 'image' : 'editable', reasons: [...new Set(reasons)] }
  })
}

function paint(fill: Fill | undefined, opacity: number): PptxGenJS.ShapeFillProps {
  return { color: fill ? hex(fill.color) : 'FFFFFF', transparency: transparency(fill ? fill.opacity * fill.color.a * opacity : 0) }
}
function position(node: SceneNode) {
  return { x: px(node.x), y: px(node.y), w: px(node.width), h: px(node.height), rotate: (node.rotation % 360 + 360) % 360, objectName: node.name }
}
function addNative(slide: PptxGenJS.Slide, node: SceneNode) {
  const fill = visiblePaint(node)[0]
  if (node.type === 'TEXT') {
    slide.addText(node.text, {
      ...position(node),
      fontFace: node.fontFamily,
      fontSize: node.fontSize * POINTS_PER_PX,
      bold: node.fontWeight === 700,
      italic: node.italic,
      color: fill ? hex(fill.color) : '000000',
      transparency: transparency(fill ? fill.color.a * fill.opacity * node.opacity : 0),
      align: ({ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' } as const)[node.textAlignHorizontal],
      valign: ({ TOP: 'top', CENTER: 'middle', BOTTOM: 'bottom' } as const)[node.textAlignVertical],
      charSpacing: node.letterSpacing * POINTS_PER_PX,
      ...(node.lineHeight === null ? {} : { lineSpacing: node.lineHeight * POINTS_PER_PX }),
      underline: node.textDecoration === 'UNDERLINE' ? { style: 'sng' } : undefined,
      strike: node.textDecoration === 'STRIKETHROUGH',
      margin: 0, breakLine: false, paraSpaceAfter: 0, paraSpaceBefore: 0,
      fit: 'none', wrap: node.textAutoResize !== 'WIDTH_AND_HEIGHT',
    })
    return
  }
  const stroke = node.strokes.find(s => s.visible)
  slide.addShape(node.type === 'ELLIPSE' ? 'ellipse' : 'rect', {
    ...position(node),
    fill: paint(fill, node.opacity),
    line: stroke ? { color: hex(stroke.color), transparency: transparency(stroke.color.a * stroke.opacity * node.opacity), width: stroke.weight * POINTS_PER_PX }
      : { color: '000000', transparency: 100, width: 0 },
  })
}

export async function createPowerPoint(graph: SceneGraph, deck: PowerPointDeck, options: PowerPointOptions) {
  const report = planPowerPoint(graph, deck, options)
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'PENCIL_WIDE', width: SLIDE_WIDTH_IN, height: SLIDE_HEIGHT_IN })
  pptx.layout = 'PENCIL_WIDE'
  pptx.author = 'Pencil Slides'
  pptx.subject = 'Slide deck exported from Pencil Slides'
  pptx.title = deck.title
  pptx.theme = { headFontFace: 'Inter', bodyFontFace: 'Inter' }
  const fonts = new Set<string>()
  options.onProgress?.(0, report.length)
  for (const [index, item] of report.entries()) {
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    if (item.mode === 'image') {
      const data = await options.renderSlide(item.id)
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data)) throw new Error(`Could not render "${item.title}" as a PNG. No PowerPoint file was created.`)
      slide.addImage({ data, x: 0, y: 0, w: SLIDE_WIDTH_IN, h: SLIDE_HEIGHT_IN, objectName: `${item.title} (rendered slide)`, altText: `${item.title}. Rendered slide; contents are not individually editable.` })
    } else {
      const frame = graph.getNode(item.id)!
      // A native background shape preserves solid fill alpha without changing child opacity.
      slide.addShape('rect', { x: 0, y: 0, w: SLIDE_WIDTH_IN, h: SLIDE_HEIGHT_IN, objectName: 'Slide background', fill: paint(visiblePaint(frame)[0], 1), line: { transparency: 100, width: 0 } })
      for (const id of frame.childIds) {
        const node = graph.getNode(id)!
        if (!node.visible) continue
        if (node.type === 'TEXT') fonts.add(node.fontFamily)
        addNative(slide, node)
      }
    }
    slide.addNotes(`${index + 1}. ${item.title}\nPencil Slides\n${item.mode === 'image' ? `Rendered image — not individually editable.\n${item.reasons.join('\n')}` : 'Editable text and basic shapes. Fonts are not embedded; PowerPoint may reflow text.'}`)
    options.onProgress?.(index + 1, report.length)
  }
  const raw = await pptx.write({ outputType: 'arraybuffer', compression: true })
  if (!(raw instanceof ArrayBuffer)) throw new Error('PowerPoint serialization returned an unexpected result.')
  return { bytes: new Uint8Array(raw), report, fonts: [...fonts].sort() }
}
