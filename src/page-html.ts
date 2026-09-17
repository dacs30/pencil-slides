import { SceneGraph, type SceneNode, type Fill, type Color } from '@open-pencil/scene-graph'
import { restorePage, pageSizing } from './page-document'
import { pageSnapshotSchema, type PageSnapshot } from '../shared/page'

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function numeric(value: number) { if (!Number.isFinite(value)) throw new Error('Page contains invalid style geometry.'); return value }
const px = (value: number) => `${numeric(value)}px`
function rgba(color: Color, opacity = 1) {
  const channels = [color.r, color.g, color.b].map(c => Math.round(Math.max(0, Math.min(1, numeric(c))) * 255))
  return `rgba(${channels.join(',')},${Math.max(0, Math.min(1, numeric(color.a) * numeric(opacity)))})`
}
function paint(fills: Fill[]) {
  const visible = fills.filter(f => f.visible)
  if (visible.length > 1 || visible.some(f => f.type !== 'SOLID')) throw new Error('HTML preview supports one solid fill per element.')
  return visible[0] ? rgba(visible[0].color, visible[0].opacity) : 'transparent'
}
function textStyle(node: SceneNode) {
  return `font-size:${px(node.fontSize)};font-weight:${numeric(node.fontWeight)};font-style:${node.italic ? 'italic' : 'normal'};text-decoration:${node.textDecoration === 'UNDERLINE' ? 'underline' : node.textDecoration === 'STRIKETHROUGH' ? 'line-through' : 'none'};color:${paint(node.fills)}`
}
function textRuns(node: SceneNode) {
  const boundaries = new Set([0, node.text.length])
  for (const run of node.styleRuns) { boundaries.add(Math.max(0, Math.min(node.text.length, run.start))); boundaries.add(Math.max(0, Math.min(node.text.length, run.start + run.length))) }
  const positions = [...boundaries].sort((a, b) => a - b)
  return positions.slice(0, -1).map((start, index) => {
    const run = node.styleRuns.find(r => r.start <= start && r.start + r.length > start)
    const text = escape(node.text.slice(start, positions[index + 1]))
    if (!run) return text
    return `<span style="${textStyle({ ...node, ...run.style })}">${text}</span>`
  }).join('')
}
export function pageHtml(snapshot: PageSnapshot, options: { localFonts?: boolean } = {}) {
  const data = pageSnapshotSchema.parse(snapshot), graph = new SceneGraph()
  restorePage(graph, data)
  const root = graph.getNode(data.frameId)!
  let firstHeading = true
  function render(node: SceneNode, parent?: SceneNode): string {
    if (!node.visible) return ''
    if (node.isMask || node.effects.some(e => e.visible) || !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) throw new Error(`HTML preview cannot represent masks, effects or blending on "${node.name}".`)
    if (!['NONE', 'VERTICAL', 'HORIZONTAL'].includes(node.layoutMode)) throw new Error(`Unsupported layout on "${node.name}".`)
    const isRoot = node.id === data.frameId
    const flow = parent && parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE'
    const auto = node.type === 'FRAME' && node.layoutMode !== 'NONE'
    const style = [
      'box-sizing:border-box', `opacity:${numeric(node.opacity)}`, 'min-width:0',
      `position:${parent && !flow ? 'absolute' : 'relative'}`,
      ...(parent && !flow ? [`left:${px(node.x)}`, `top:${px(node.y)}`] : []),
      `width:${isRoot || (flow && pageSizing(node, parent, 'HORIZONTAL') === 'FILL') ? '100%' : px(node.width)}`,
      `height:${auto && pageSizing(node, parent, 'VERTICAL') === 'HUG' || node.type === 'TEXT' && node.textAutoResize !== 'NONE' ? 'auto' : px(node.height)}`,
      `transform:rotate(${numeric(node.rotation)}deg)`, `border-radius:${node.type === 'ELLIPSE' ? '50%' : px(node.cornerRadius)}`,
      `overflow:${node.clipsContent ? 'hidden' : 'visible'}`,
    ]
    if (flow && parent?.layoutMode === 'HORIZONTAL' && pageSizing(node, parent, 'HORIZONTAL') === 'FILL') style.push(`flex:1 1 ${px(Math.min(node.width, 260))}`, 'width:auto')
    if (flow) style.push('max-width:100%', 'flex-shrink:0')
    if (node.type !== 'TEXT') style.push(`background:${paint(node.fills)}`)
    const strokes = node.strokes.filter(s => s.visible && s.weight > 0)
    if (strokes.length > 1) throw new Error('HTML preview supports one outline per element.')
    if (strokes[0]) style.push(`outline:${px(strokes[0].weight)} solid ${rgba(strokes[0].color, strokes[0].opacity)}`, `outline-offset:${px(-strokes[0].weight / 2)}`)
    if (auto) style.push('display:flex', `flex-direction:${node.layoutMode === 'VERTICAL' ? 'column' : 'row'}`, `flex-wrap:${node.layoutWrap === 'WRAP' ? 'wrap' : 'nowrap'}`, `gap:${px(node.itemSpacing)}`, `padding:${px(node.paddingTop)} ${px(node.paddingRight)} ${px(node.paddingBottom)} ${px(node.paddingLeft)}`)
    let tag = isRoot ? 'main' : node.type === 'FRAME' ? 'section' : 'div'
    let children = ''
    if (node.type === 'TEXT') {
      if (node.fontSize >= 36 && node.fontWeight >= 600) { tag = firstHeading ? 'h1' : 'h2'; firstHeading = false }
      else tag = 'p'
      const align = ({ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' } as const)[node.textAlignHorizontal]
      if (!align) throw new Error('Invalid text alignment.')
      style.push(textStyle(node), 'margin:0', 'white-space:pre-wrap', 'overflow-wrap:anywhere', `text-align:${align}`, `line-height:${node.lineHeight === null ? 'normal' : px(node.lineHeight)}`, `letter-spacing:${px(node.letterSpacing)}`)
      children = textRuns(node)
    } else children = node.childIds.map(id => render(graph.getNode(id)!, node)).join('')
    return `<${tag} data-page-node="${escape(node.id)}"${node.type === 'TEXT' ? '' : ` aria-label="${escape(node.name)}"`} style="${style.join(';')}">${children}</${tag}>`
  }
  const fonts = options.localFonts ? "@font-face{font-family:Inter;src:url('/Inter-Regular.ttf')}@font-face{font-family:Inter;src:url('/Inter-Bold.ttf');font-weight:700}" : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'"><title>${escape(data.title)}</title><style>${fonts}html,body{margin:0;min-height:100%;background:${paint(root.fills)};font-family:Inter,Arial,sans-serif}body{overflow-x:hidden}main{min-height:100vh}::selection{background:#e5b998}</style></head><body>${render(root)}</body></html>`
}
