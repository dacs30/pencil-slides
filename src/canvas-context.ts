import type { SceneGraph } from '@open-pencil/scene-graph'
import type { CommentAnchorInput } from '../shared/comments'
import { objectPointOnSlide, screenToSlidePoint, type CommentView, type Point } from './comment-geometry'

export function pointerCommentAnchor(graph: SceneGraph, slideId: string, screen: Point, rect: { left: number; top: number }, view: CommentView): CommentAnchorInput | null {
  const point = screenToSlidePoint(graph, slideId, screen, rect, view)
  if (!point) return null
  const worldX = (screen.x - rect.left - view.panX) / view.zoom
  const worldY = (screen.y - rect.top - view.panY) / view.zoom
  // Scope SDK hit testing to the visible slide, not the editor's previously entered container.
  const hit = graph.hitTestDeep(worldX, worldY, slideId)
  if (hit && hit.id !== slideId && objectPointOnSlide(graph, hit.id, slideId)) return { kind: 'object', slideId, nodeId: hit.id }
  return { kind: 'point', slideId, ...point }
}
export function keyboardCommentAnchor(graph: SceneGraph, slideId: string, selectedIds: Iterable<string>): CommentAnchorInput | null {
  const slide = graph.getNode(slideId)
  if (!slide) return null
  for (const nodeId of selectedIds) {
    if (objectPointOnSlide(graph, nodeId, slideId)) return { kind: 'object', slideId, nodeId }
  }
  return { kind: 'point', slideId, x: slide.width / 2, y: slide.height / 2 }
}
export function clampContextMenu(point: Point, size: { width: number; height: number }, viewport: { width: number; height: number }): Point {
  const margin = 8
  return {
    x: Math.min(Math.max(margin, point.x), Math.max(margin, viewport.width - size.width - margin)),
    y: Math.min(Math.max(margin, point.y), Math.max(margin, viewport.height - size.height - margin)),
  }
}
