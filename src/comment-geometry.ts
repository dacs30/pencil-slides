import { getWorldMatrix, TransformMatrix, type SceneGraph, type Mat3 } from '@open-pencil/scene-graph'
import type { CommentThread, Detachment } from '../shared/comments'

export type Point = { x: number; y: number }
export type CommentView = { panX: number; panY: number; zoom: number }
function transform(matrix: Mat3, point: Point): Point {
  return { x: matrix[0] * point.x + matrix[1] * point.y + matrix[2], y: matrix[3] * point.x + matrix[4] * point.y + matrix[5] }
}
export function belongsToSlide(graph: SceneGraph, nodeId: string, slideId: string) {
  const seen = new Set<string>()
  let id: string | null = nodeId
  while (id && !seen.has(id) && seen.size < 2000) {
    if (id === slideId) return true
    seen.add(id)
    id = graph.getNode(id)?.parentId ?? null
  }
  return false
}
export function objectPointOnSlide(graph: SceneGraph, nodeId: string, slideId: string): Point | null {
  const node = graph.getNode(nodeId), slide = graph.getNode(slideId)
  if (!node || !slide || nodeId === slideId || !belongsToSlide(graph, nodeId, slideId)) return null
  const inverse = TransformMatrix.invert(getWorldMatrix(slide, graph))
  if (!inverse) return null
  return transform(inverse, transform(getWorldMatrix(node, graph), { x: node.width / 2, y: node.height / 2 }))
}
export function resolveCommentAnchor(graph: SceneGraph, thread: CommentThread): { point: Point | null; detached: Detachment; offSlide: boolean } {
  const slide = graph.getNode(thread.anchor.slideId)
  if (!slide || thread.detached === 'slide_deleted') return { point: null, detached: 'slide_deleted', offSlide: false }
  let detached = thread.detached
  let point: Point = { x: thread.anchor.x, y: thread.anchor.y }
  if (!detached && thread.anchor.kind === 'object') {
    const attached = objectPointOnSlide(graph, thread.anchor.nodeId!, slide.id)
    if (attached) point = attached
    else detached = graph.getNode(thread.anchor.nodeId!) ? 'object_moved' : 'object_deleted'
  }
  return { point, detached, offSlide: point.x < 0 || point.y < 0 || point.x > slide.width || point.y > slide.height }
}
export function slidePointToViewport(graph: SceneGraph, slideId: string, point: Point, view: CommentView): Point | null {
  const slide = graph.getNode(slideId)
  if (!slide) return null
  const world = transform(getWorldMatrix(slide, graph), point)
  return { x: world.x * view.zoom + view.panX, y: world.y * view.zoom + view.panY }
}
export function screenToSlidePoint(graph: SceneGraph, slideId: string, screen: Point, rect: { left: number; top: number }, view: CommentView): Point | null {
  const slide = graph.getNode(slideId)
  if (!slide || !Number.isFinite(view.zoom) || view.zoom <= 0) return null
  const inverse = TransformMatrix.invert(getWorldMatrix(slide, graph))
  if (!inverse) return null
  const world = { x: (screen.x - rect.left - view.panX) / view.zoom, y: (screen.y - rect.top - view.panY) / view.zoom }
  const raw = transform(inverse, world)
  const point = { x: Math.round(raw.x * 100) / 100, y: Math.round(raw.y * 100) / 100 }
  if (![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.x > slide.width || point.y > slide.height) return null
  return point
}
