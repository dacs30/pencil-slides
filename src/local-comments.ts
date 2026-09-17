import { SceneGraph } from '@open-pencil/scene-graph'
import type { OpenArtifact } from '../shared/artifacts'
import { createCommentSchema, createPageCommentSchema, type CommentThread } from '../shared/comments'
import { textCommentSchema, type TextThread } from '../shared/text-comments'
import { richSchema } from '../shared/rich-text'
import { WorkspaceError, type StoredComment } from '../shared/browser-storage'
import { restore } from './document'
import { restorePage } from './page-document'
import { objectPointOnSlide, resolveCommentAnchor } from './comment-geometry'

export function canvasGraph(artifact: OpenArtifact) {
  if (artifact.kind === 'document') throw new WorkspaceError('Expected a canvas artifact.')
  const graph = new SceneGraph()
  if (artifact.kind === 'page') restorePage(graph, artifact.value.snapshot)
  else restore(graph, artifact.value.snapshot)
  return graph
}
export function createLocalComment(artifact: OpenArtifact, raw: unknown): StoredComment {
  if (artifact.kind === 'document') {
    const input = textCommentSchema.parse(raw)
    if (input.expectedRevision !== artifact.value.revision) throw new WorkspaceError('Document changed. Reload before commenting.', 409)
    const doc = richSchema.nodeFromJSON(artifact.value.snapshot.content)
    if (input.from >= input.to || input.to > doc.content.size) throw new WorkspaceError('Invalid comment range.')
    const quote = doc.textBetween(input.from, input.to, '\n')
    if (!quote.trim() || quote.length > 2000) throw new WorkspaceError('Select between 1 and 2,000 characters to comment.')
    return { kind: 'document', thread: { id: input.id, documentId: artifact.value.id, version: 1, resolved: false, anchor: { from: input.from, to: input.to, quote, detached: false }, messages: [{ id: input.id, body: input.body }] } }
  }
  const input = (artifact.kind === 'page' ? createPageCommentSchema : createCommentSchema).parse(raw)
  if (input.expectedRevision !== artifact.value.revision) throw new WorkspaceError('Artwork changed. Reload before commenting.', 409)
  const frames = artifact.kind === 'page' ? [{ id: artifact.value.snapshot.frameId, title: artifact.value.snapshot.title }] : artifact.value.snapshot.slides
  const frame = frames.find(f => f.id === input.anchor.slideId)
  if (!frame) throw new WorkspaceError('The target artboard no longer exists.', 409)
  const graph = canvasGraph(artifact), node = input.anchor.kind === 'object' ? graph.getNode(input.anchor.nodeId) : undefined
  const point = input.anchor.kind === 'object' ? objectPointOnSlide(graph, input.anchor.nodeId, frame.id) : input.anchor
  if (!point) throw new WorkspaceError('The object no longer belongs to this artboard.', 409)
  const bounds = graph.getNode(frame.id)!
  if (input.anchor.kind === 'point' && (point.x > bounds.width || point.y > bounds.height)) throw new WorkspaceError('Choose a point inside the artboard.')
  const now = new Date().toISOString()
  const thread: CommentThread = {
    id: input.id, deckId: artifact.value.id, anchor: { ...input.anchor, x: point.x, y: point.y },
    slideTitle: frame.title, nodeName: node?.name.slice(0, 200) ?? null, resolved: false, version: 1, detached: null,
    createdAt: now, updatedAt: now, messages: [{ id: input.id, body: input.body, createdAt: now }],
  }
  return { kind: 'canvas', thread }
}
export function reconcileCanvasComments(artifact: OpenArtifact, comments: StoredComment[]) {
  const graph = canvasGraph(artifact)
  return comments.map(comment => {
    if (comment.kind !== 'canvas') throw new WorkspaceError('Comment type does not match its artifact.')
    const detached = resolveCommentAnchor(graph, comment.thread).detached
    return detached === comment.thread.detached ? comment : {
      kind: 'canvas' as const, thread: { ...comment.thread, detached, version: comment.thread.version + 1, updatedAt: new Date().toISOString() },
    }
  })
}
export function commentCreationIdentity(comment: StoredComment) {
  const t = comment.thread
  if (comment.kind === 'document') return { artifactId: comment.thread.documentId, from: comment.thread.anchor.from, to: comment.thread.anchor.to, body: t.messages[0]!.body }
  const anchor = comment.thread.anchor
  return { artifactId: comment.thread.deckId, anchor: anchor.kind === 'object' ? { kind: anchor.kind, slideId: anchor.slideId, nodeId: anchor.nodeId } : anchor, body: t.messages[0]!.body }
}
export function commentOwner(comment: StoredComment) { return comment.kind === 'document' ? comment.thread.documentId : comment.thread.deckId }
export function commentHandoff(artifact: OpenArtifact, comment: StoredComment, expectedVersion: number) {
  const thread: CommentThread | TextThread = comment.thread
  if (thread.version !== expectedVersion || thread.resolved) throw new WorkspaceError('Comment changed or resolved. Refresh before asking Claude.', 409)
  if (comment.kind === 'canvas' && comment.thread.detached === 'slide_deleted') throw new WorkspaceError('The referenced artboard was deleted.', 409)
  let remaining = 14000
  const messages = [thread.messages[0]!, ...thread.messages.slice(1).slice(-9)].map(m => {
    const body = m.body.slice(0, Math.max(0, remaining)); remaining -= body.length; return body
  }).filter(Boolean)
  return {
    artifactId: artifact.value.id, kind: artifact.kind, threadId: thread.id, version: thread.version,
    anchor: thread.anchor,
    detached: comment.kind === 'canvas' ? comment.thread.detached : comment.thread.anchor.detached ? 'text_deleted' : null,
    messages, truncated: thread.messages.length > 10 || remaining <= 0,
  }
}
