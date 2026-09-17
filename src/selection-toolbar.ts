import { getWorldMatrix, TransformMatrix, type SceneGraph, type SceneNode } from '@open-pencil/scene-graph'
import { belongsToSlide, type CommentView } from './comment-geometry'

export type SelectionBounds = { left: number; top: number; right: number; bottom: number }
export function toolbarSelection(graph: SceneGraph, ids: Iterable<string>, slideId: string): SceneNode | null {
  const selected = [...ids]
  if (selected.length !== 1) return null
  const node = graph.getNode(selected[0]!)
  return node?.visible && ['TEXT', 'RECTANGLE', 'ELLIPSE'].includes(node.type) && !node.childIds.length && belongsToSlide(graph, node.id, slideId) ? node : null
}
export function selectionViewportBounds(graph: SceneGraph, node: SceneNode, view: CommentView): SelectionBounds {
  const points = TransformMatrix.mapPoints(getWorldMatrix(node, graph), [0, 0, node.width, 0, node.width, node.height, 0, node.height])
  const xs = [points[0], points[2], points[4], points[6]].map(x => x! * view.zoom + view.panX)
  const ys = [points[1], points[3], points[5], points[7]].map(y => y! * view.zoom + view.panY)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}
export function placeSelectionToolbar(bounds: SelectionBounds, viewport: { width: number; height: number }, toolbar: { width: number; height: number }) {
  const margin = 8, gap = 24
  if (viewport.width < 40 || viewport.height < 60 || bounds.right < 0 || bounds.bottom < 0 || bounds.left > viewport.width || bounds.top > viewport.height) return null
  const width = Math.min(toolbar.width, viewport.width - margin * 2)
  const x = Math.max(margin, Math.min((bounds.left + bounds.right - width) / 2, viewport.width - width - margin))
  const above = bounds.top - toolbar.height - gap
  const below = bounds.bottom + gap
  const preferAbove = above >= margin
  const y = preferAbove ? above : below + toolbar.height <= viewport.height - margin ? below : bounds.top + gap
  return { x, y: Math.max(margin, Math.min(y, viewport.height - toolbar.height - margin)), side: preferAbove ? 'above' as const : 'below' as const }
}
type TextAttribute = 'fontSize' | 'fontWeight' | 'italic' | 'textDecoration'
export function textAttributeValues<K extends TextAttribute>(node: SceneNode, key: K): SceneNode[K][] {
  const runs = node.styleRuns.filter(run => run.length > 0 && run.start < node.text.length).toSorted((a, b) => a.start - b.start)
  const values = runs.map(run => (run.style[key] ?? node[key]) as SceneNode[K])
  let covered = 0, gap = false
  for (const run of runs) {
    if (run.start > covered) gap = true
    covered = Math.max(covered, run.start + run.length)
  }
  if (!runs.length || gap || covered < node.text.length) values.push(node[key])
  return [...new Set(values)]
}
export function textToggleState(node: SceneNode, kind: 'bold' | 'italic' | 'underline'): boolean | 'mixed' {
  const values = kind === 'bold' ? textAttributeValues(node, 'fontWeight').map(value => value >= 600)
    : kind === 'italic' ? textAttributeValues(node, 'italic')
      : textAttributeValues(node, 'textDecoration').map(value => value === 'UNDERLINE')
  return values.every(Boolean) ? true : values.some(Boolean) ? 'mixed' : false
}
