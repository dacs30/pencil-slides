import { SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import { computeLayout } from '@open-pencil/core/layout'
import { fill, elementChanges, encode, decode, restoreGraphNodes } from './document'
import { pageSnapshotSchema, type PageSnapshot, type PageOperation, type PageElementProperties } from '../shared/page'

export function capturePage(graph: SceneGraph, meta: Pick<PageSnapshot, 'title' | 'pageId' | 'frameId'>): PageSnapshot {
  const nodes = [...graph.getAllNodes()].filter(n => n.id !== graph.rootId && n.id !== meta.pageId)
  return pageSnapshotSchema.parse(JSON.parse(JSON.stringify({ version: 1, ...meta, nodes }, encode)))
}
export function restorePage(graph: SceneGraph, snapshot: PageSnapshot) {
  const saved = JSON.parse(JSON.stringify(pageSnapshotSchema.parse(snapshot)), decode) as Omit<PageSnapshot, 'nodes'> & { nodes: SceneNode[] }
  restoreGraphNodes(graph, saved.pageId, saved.nodes, [saved.frameId])
}
export function blankPage(title = 'Untitled page'): PageSnapshot {
  const graph = new SceneGraph(), pageId = graph.getPages()[0]!.id, frameId = `page-${crypto.randomUUID()}`
  graph.createNode('FRAME', pageId, {
    id: frameId, name: title, width: 1200, height: 900, clipsContent: true,
    fills: fill('#f4efe5'), layoutMode: 'VERTICAL', primaryAxisSizing: 'HUG',
    paddingTop: 80, paddingRight: 80, paddingBottom: 80, paddingLeft: 80, itemSpacing: 32,
  })
  graph.createNode('TEXT', frameId, {
    id: `title-${crypto.randomUUID()}`, name: 'Page heading', text: title, width: 1040, height: 100,
    fontFamily: 'Inter', fontSize: 72, fontWeight: 700, fills: fill('#25231f'),
    counterAxisSizing: 'FILL', textAutoResize: 'HEIGHT',
  })
  graph.createNode('TEXT', frameId, {
    id: `body-${crypto.randomUUID()}`, name: 'Introduction', text: 'Tell a story worth exploring.', width: 1040, height: 80,
    fontFamily: 'Inter', fontSize: 26, fills: fill('#686155'), counterAxisSizing: 'FILL', textAutoResize: 'HEIGHT',
  })
  computeLayout(graph, frameId)
  return capturePage(graph, { title, pageId, frameId })
}
export function pageSizing(node: SceneNode, parent: SceneNode | undefined, axis: 'HORIZONTAL' | 'VERTICAL') {
  const mode = node.layoutMode !== 'NONE' ? node.layoutMode : parent?.layoutMode ?? 'NONE'
  return mode === 'NONE' ? 'FIXED' : mode === axis ? node.primaryAxisSizing : node.counterAxisSizing
}
function changes(node: SceneNode, props: PageElementProperties, parent?: SceneNode): Partial<SceneNode> {
  const { layoutMode, layoutWrap, layoutSizingHorizontal, layoutSizingVertical, itemSpacing, paddingTop, paddingRight, paddingBottom, paddingLeft, textAutoResize, ...element } = props
  if (node.type !== 'FRAME' && [layoutMode, layoutWrap, itemSpacing, paddingTop, paddingRight, paddingBottom, paddingLeft].some(v => v !== undefined)) throw new Error('Layout and padding controls require a frame.')
  if (node.type !== 'TEXT' && textAutoResize !== undefined) throw new Error('Text sizing requires a text element.')
  const values = { layoutMode, layoutWrap, itemSpacing, paddingTop, paddingRight, paddingBottom, paddingLeft, textAutoResize }
  // Page frames share rectangle paint, outline and corner controls.
  const result: Partial<SceneNode> = { ...elementChanges(node.type === 'FRAME' ? 'RECTANGLE' : node.type, element, node), ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) }
  const mode = (layoutMode ?? node.layoutMode) !== 'NONE' ? layoutMode ?? node.layoutMode : parent?.layoutMode ?? 'NONE'
  if (layoutSizingHorizontal) result[mode === 'VERTICAL' ? 'counterAxisSizing' : 'primaryAxisSizing'] = layoutSizingHorizontal
  if (layoutSizingVertical) result[mode === 'HORIZONTAL' ? 'counterAxisSizing' : 'primaryAxisSizing'] = layoutSizingVertical
  if (parent?.layoutMode === 'HORIZONTAL' && layoutSizingHorizontal) result.layoutGrow = layoutSizingHorizontal === 'FILL' ? 1 : 0
  if (parent?.layoutMode === 'VERTICAL' && layoutSizingVertical) result.layoutGrow = layoutSizingVertical === 'FILL' ? 1 : 0
  return result
}
export function applyPageOperations(graph: SceneGraph, meta: Pick<PageSnapshot, 'title' | 'pageId' | 'frameId'>, operations: PageOperation[]) {
  const element = (id: string) => {
    const node = graph.getNode(id)
    if (!node || node.id === graph.rootId || node.id === meta.pageId) throw new Error(`Page element not found: ${id}`)
    return node
  }
  for (const op of operations) {
    if (op.op === 'update_page') {
      if (op.title) meta.title = op.title
      graph.updateNode(meta.frameId, { ...(op.title ? { name: op.title } : {}), ...(op.width ? { width: op.width } : {}), ...(op.background ? { fills: fill(op.background) } : {}) })
    } else if (op.op === 'create_page_element') {
      if (graph.getNode(op.id)) throw new Error('Page element ID already exists.')
      if (element(op.parentId).type !== 'FRAME') throw new Error('Page parent must be a frame.')
      const node = graph.createNode(op.type, op.parentId, {
        id: op.id, name: op.type === 'FRAME' ? 'Section' : op.type === 'TEXT' ? 'Text' : 'Shape',
        width: 500, height: op.type === 'TEXT' ? 80 : 240, fontFamily: 'Inter', fontSize: 26,
        fills: fill(op.type === 'TEXT' ? '#25231f' : '#e9dfcf'),
        ...(op.type === 'FRAME' ? { layoutMode: 'VERTICAL', primaryAxisSizing: 'HUG', itemSpacing: 20, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 } : {}),
        ...(op.type === 'TEXT' ? { text: 'Your text', textAutoResize: 'HEIGHT' } : {}),
      })
      graph.updateNode(node.id, changes(node, { layoutSizingHorizontal: 'FILL', ...op.props }, element(op.parentId)))
    } else if (op.op === 'update_page_element') {
      const node = element(op.id)
      if (op.id === meta.frameId && (op.props.width !== undefined || op.props.height !== undefined || op.props.layoutSizingHorizontal !== undefined)) throw new Error('Use update_page to resize the root artboard.')
      graph.updateNode(op.id, changes(node, op.props, node.parentId ? graph.getNode(node.parentId) : undefined))
    } else if (op.op === 'delete_page_element') {
      element(op.id)
      if (op.id === meta.frameId) throw new Error('Cannot delete the page artboard.')
      graph.deleteNode(op.id)
    } else {
      const node = element(op.id), parent = element(op.parentId)
      if (node.id === meta.frameId || parent.type !== 'FRAME') throw new Error('Invalid page move.')
      let ancestor: SceneNode | undefined = parent
      while (ancestor) {
        if (ancestor.id === node.id) throw new Error('Cannot move an element into itself or its descendant.')
        ancestor = ancestor.parentId ? graph.getNode(ancestor.parentId) : undefined
      }
      if (node.parentId !== parent.id) graph.reparentNode(node.id, parent.id)
      graph.reorderChild(node.id, parent.id, op.index)
    }
  }
  computeLayout(graph, meta.frameId)
  capturePage(graph, meta)
}
