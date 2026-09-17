import { SceneGraph, type SceneNode, type Fill } from '@open-pencil/scene-graph'
import type { Editor } from '@open-pencil/core/editor'
import { snapshotSchema, type Snapshot, type Operation, type ElementProperties } from '../shared/model'

export function fill(hex: string): Fill[] {
  return [{ type: 'SOLID', color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 }, opacity: 1, visible: true }]
}
export function elementChanges(type: SceneNode['type'], p: ElementProperties, current?: SceneNode): Partial<SceneNode> {
  const { fill: color, stroke, strokeWidth, cornerRadius, ...rest } = p
  const changes: Partial<SceneNode> = { ...rest, ...(color ? { fills: fill(color) } : {}) }
  if (type !== 'TEXT' && (p.italic !== undefined || p.textDecoration !== undefined || p.textAlignHorizontal !== undefined)) throw new Error('Text formatting requires a text object.')
  if (stroke !== undefined || strokeWidth !== undefined) {
    if (type !== 'RECTANGLE' && type !== 'ELLIPSE') throw new Error('Outline controls require a rectangle or ellipse.')
    if ((current?.strokes.length ?? 0) > 1) throw new Error('The compact outline control supports one outline.')
    const previous = current?.strokes[0]
    const weight = strokeWidth ?? previous?.weight ?? 2
    changes.strokes = weight === 0 ? [] : [{
      ...previous,
      color: stroke ? fill(stroke)[0]!.color : previous?.color ?? fill('#34332f')[0]!.color,
      opacity: previous?.opacity ?? 1, align: previous?.align ?? 'CENTER', visible: true,
      weight,
    }]
  }
  if (cornerRadius !== undefined) {
    if (type !== 'RECTANGLE') throw new Error('Corner radius requires a rectangle.')
    changes.cornerRadius = cornerRadius
    changes.independentCorners = false
    changes.topLeftRadius = changes.topRightRadius = changes.bottomLeftRadius = changes.bottomRightRadius = 0
  }
  if (type === 'TEXT' && (color || p.fontSize !== undefined || p.fontWeight !== undefined || p.italic !== undefined || p.textDecoration !== undefined)) {
    // Whole-object formatting changes only the requested attributes, including existing rich runs.
    changes.styleRuns = (current?.styleRuns ?? []).map(run => ({
      ...run,
      style: {
        ...run.style,
        ...(color ? { fills: fill(color) } : {}),
        ...(p.fontSize !== undefined ? { fontSize: p.fontSize } : {}),
        ...(p.fontWeight !== undefined ? { fontWeight: p.fontWeight } : {}),
        ...(p.italic !== undefined ? { italic: p.italic } : {}),
        ...(p.textDecoration !== undefined ? { textDecoration: p.textDecoration } : {}),
      },
    }))
  }
  return changes
}
function encode(_key: string, value: unknown): unknown {
  if (value instanceof Map) return { $map: [...value] }
  if (value instanceof Uint8Array) return { $bytes: [...value] }
  return value
}
function decode(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    if ('$map' in value) return new Map(value.$map as [string, unknown][])
    if ('$bytes' in value) return new Uint8Array(value.$bytes as number[])
  }
  return value
}
export function snapshot(graph: SceneGraph, meta: Pick<Snapshot, 'title' | 'slides' | 'pageId'>): Snapshot {
  const nodes = [...graph.getAllNodes()].filter(n => n.id !== graph.rootId && n.id !== meta.pageId).sort((a, b) => a.id.localeCompare(b.id))
  return snapshotSchema.parse(JSON.parse(JSON.stringify({ version: 1, ...meta, nodes }, encode)))
}
export function restore(graph: SceneGraph, data: Snapshot) {
  const saved = JSON.parse(JSON.stringify(snapshotSchema.parse(data)), decode) as Omit<Snapshot, 'nodes'> & { nodes: SceneNode[] }
  const page = graph.getPages()[0]!
  for (const id of [...page.childIds]) graph.deleteNode(id)
  if (saved.pageId === graph.rootId || saved.nodes.some(n => n.id === graph.rootId)) {
    const root = graph.getNode(graph.rootId)!
    graph.nodes.delete(root.id)
    root.id = `document:${crypto.randomUUID()}`
    graph.rootId = root.id
    graph.nodes.set(root.id, root)
    page.parentId = root.id
  }
  if (page.id !== saved.pageId) {
    graph.nodes.delete(page.id)
    graph.getNode(graph.rootId)!.childIds = [saved.pageId]
    page.id = saved.pageId
    graph.nodes.set(page.id, page)
  }
  const byId = new Map(saved.nodes.map(n => [n.id, n]))
  for (const slide of saved.slides) {
    const frame = byId.get(slide.id)!
    graph.createNode('FRAME', page.id, { ...frame, childIds: [] })
    for (const id of frame.childIds) {
      const node = byId.get(id)!
      graph.createNode(node.type, frame.id, { ...node, childIds: [] })
    }
  }
  graph.clearAbsPosCache()
}
export function blankDeck(): Snapshot {
  const graph = new SceneGraph()
  const pageId = graph.getPages()[0]!.id
  const id = crypto.randomUUID()
  graph.createNode('FRAME', pageId, { id, name: 'Your next big idea', width: 1920, height: 1080, fills: fill('#f8f5ef'), clipsContent: true })
  graph.createNode('TEXT', id, { id: crypto.randomUUID(), name: 'Title', x: 150, y: 260, width: 1600, height: 220, text: 'Your next big idea', fontSize: 112, fontFamily: 'Inter', fontWeight: 700, fills: fill('#202c3b') })
  graph.createNode('TEXT', id, { id: crypto.randomUUID(), name: 'Subtitle', x: 158, y: 540, width: 1400, height: 160, text: 'Start with a blank canvas. Make something worth sharing.', fontSize: 44, fontFamily: 'Inter', fills: fill('#526170') })
  graph.createNode('RECTANGLE', id, { id: crypto.randomUUID(), name: 'Accent', x: 160, y: 200, width: 120, height: 14, fills: fill('#eb704f') })
  return snapshot(graph, { title: 'Untitled deck', pageId, slides: [{ id, title: 'Your next big idea' }] })
}
export function applyOperations(editor: Editor, meta: Pick<Snapshot, 'title' | 'slides' | 'pageId'>, operations: Operation[]) {
  const graph = editor.graph
  const slide = (id: string) => {
    if (!meta.slides.some(s => s.id === id)) throw new Error(`Slide not found: ${id}`)
    return graph.getNode(id)!
  }
  const element = (id: string) => {
    const n = graph.getNode(id)
    if (!n || !meta.slides.some(s => s.id === n.parentId) || n.type === 'FRAME') throw new Error(`Editable element not found: ${id}`)
    return n
  }
  const unique = (id: string) => { if (graph.getNode(id)) throw new Error(`ID already exists: ${id}`) }
  for (const operation of operations) {
    switch (operation.op) {
      case 'create_slide':
        unique(operation.id)
        if (meta.slides.length >= 100) throw new Error('Slide limit is 100')
        graph.createNode('FRAME', meta.pageId, { id: operation.id, name: operation.title, width: 1920, height: 1080, x: 0, y: 0, fills: fill(operation.background ?? '#ffffff'), clipsContent: true })
        meta.slides.push({ id: operation.id, title: operation.title })
        break
      case 'update_slide': {
        slide(operation.id)
        if (operation.title) meta.slides.find(s => s.id === operation.id)!.title = operation.title
        graph.updateNode(operation.id, { ...(operation.title ? { name: operation.title } : {}), ...(operation.background ? { fills: fill(operation.background) } : {}) })
        break
      }
      case 'delete_slide':
        slide(operation.id)
        if (meta.slides.length === 1) throw new Error('Cannot delete the last slide')
        graph.deleteNode(operation.id)
        meta.slides = meta.slides.filter(s => s.id !== operation.id)
        break
      case 'reorder_slides':
        if (operation.ids.length !== meta.slides.length || new Set(operation.ids).size !== meta.slides.length) throw new Error('Reorder must include every slide exactly once')
        meta.slides = operation.ids.map(id => { slide(id); return meta.slides.find(s => s.id === id)! })
        break
      case 'create_element':
        unique(operation.id); slide(operation.slideId)
        graph.createNode(operation.type, operation.slideId, { id: operation.id, name: operation.type === 'TEXT' ? 'Text' : 'Shape', x: 160, y: 160, width: 600, height: 160, fontFamily: 'Inter', fontSize: 56, fills: fill(operation.type === 'TEXT' ? '#202c3b' : '#eb704f'), ...elementChanges(operation.type, operation.props) })
        break
      case 'update_element':
        {
          const node = element(operation.id)
          graph.updateNode(operation.id, elementChanges(node.type, operation.props, node))
        }
        break
      case 'delete_element':
        element(operation.id)
        graph.deleteNode(operation.id)
        break
    }
  }
  meta.slides.forEach((s, i) => {
    graph.updateNode(s.id, { x: i * 2120, y: 0, width: 1920, height: 1080 })
    graph.reorderChild(s.id, meta.pageId, i)
  })
  graph.clearAbsPosCache()
  editor.requestRender()
}
