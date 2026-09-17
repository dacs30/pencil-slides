import { z } from 'zod'

const nodeId = z.string().min(1).max(120)
const body = z.string().trim().min(1).max(2000)
export const commentAnchorInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), slideId: nodeId, x: z.number().finite().min(0).max(1920), y: z.number().finite().min(0).max(1080) }).strict(),
  z.object({ kind: z.literal('object'), slideId: nodeId, nodeId }).strict(),
])
export const createCommentSchema = z.object({
  id: z.uuid(), expectedRevision: z.number().int().nonnegative(), anchor: commentAnchorInput, body,
}).strict()
export const createPageCommentSchema = createCommentSchema.extend({
  anchor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('point'), slideId: nodeId, x: z.number().finite().min(0).max(1920), y: z.number().finite().min(0).max(20000) }).strict(),
    z.object({ kind: z.literal('object'), slideId: nodeId, nodeId }).strict(),
  ]),
})
export const replyCommentSchema = z.object({
  id: z.uuid(), expectedVersion: z.number().int().positive(), body,
}).strict()
export const resolveCommentSchema = z.object({
  expectedVersion: z.number().int().positive(), resolved: z.boolean(),
}).strict()
export const commentRouteSchema = z.object({ id: z.uuid(), threadId: z.uuid().optional() })
export type CommentAnchorInput = z.infer<typeof commentAnchorInput>
export type CommentAnchor = { kind: 'point' | 'object'; slideId: string; x: number; y: number; nodeId?: string }
export type Detachment = 'object_deleted' | 'object_moved' | 'slide_deleted' | null
export type CommentMessage = { id: string; body: string; createdAt: string }
export type CommentThread = {
  id: string; deckId: string; anchor: CommentAnchor; slideTitle: string; nodeName: string | null
  resolved: boolean; version: number; detached: Detachment
  createdAt: string; updatedAt: string; messages: CommentMessage[]
}
export type CommentHandoff = { commentThreadId: string; expectedCommentVersion: number; message: string }
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(12000),
  commentThreadId: z.uuid().optional(),
  expectedCommentVersion: z.number().int().positive().optional(),
}).strict().refine(data => Boolean(data.commentThreadId) === (data.expectedCommentVersion !== undefined), 'Comment handoff requires a thread ID and version')

export function detachmentLabel(value: Detachment, surface = 'slide') {
  return value === 'slide_deleted' ? `Detached · ${surface} deleted`
    : value === 'object_deleted' ? 'Detached · object deleted'
      : value === 'object_moved' ? `Detached · object moved to another ${surface}` : ''
}
