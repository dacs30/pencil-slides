import { z } from 'zod'
import { snapshotSchema } from './model.js'
import { textSnapshotSchema } from './rich-text.js'
import { pageSnapshotSchema } from './page.js'

const id = z.string().min(1).max(120)
const revision = z.number().int().nonnegative()
export const artifactInfoSchema = z.object({ id, kind: z.enum(['slides', 'document', 'page']), title: z.string().min(1).max(200), revision }).strict()
export const openArtifactSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slides'), value: z.object({ id, revision, snapshot: snapshotSchema }).strict() }).strict(),
  z.object({ kind: z.literal('document'), value: z.object({ id, revision, snapshot: textSnapshotSchema }).strict() }).strict(),
  z.object({ kind: z.literal('page'), value: z.object({ id, revision, snapshot: pageSnapshotSchema }).strict() }).strict(),
])
export const workspaceMessageSchema = z.object({
  role: z.enum(['user', 'assistant']), content: z.string().max(1000000),
  runState: z.enum(['running', 'complete', 'interrupted']).optional(),
  activities: z.array(z.object({
    id, name: z.string().max(120), status: z.enum(['running', 'complete', 'failed', 'interrupted']),
    error: z.string().max(1000000).optional(), revision: revision.optional(),
  }).strict()).max(100).optional(),
  artifacts: z.array(artifactInfoSchema).max(100).optional(),
}).strict()
export const canvasThreadSchema = z.object({
  id, deckId: id,
  anchor: z.object({ kind: z.enum(['point', 'object']), slideId: id, nodeId: id.optional(), x: z.number().finite(), y: z.number().finite() }).strict()
    .refine(a => a.kind !== 'object' || Boolean(a.nodeId), 'Object comment requires a node ID.'),
  slideTitle: z.string().max(200), nodeName: z.string().max(200).nullable(),
  resolved: z.boolean(), version: z.number().int().positive(),
  detached: z.enum(['object_deleted', 'object_moved', 'slide_deleted']).nullable(),
  createdAt: z.string().max(64), updatedAt: z.string().max(64),
  messages: z.array(z.object({ id, body: z.string().min(1).max(2000), createdAt: z.string().max(64) }).strict()).min(1).max(50),
}).strict()
export const textThreadSchema = z.object({
  id, documentId: id, resolved: z.boolean(), version: z.number().int().positive(),
  anchor: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), quote: z.string().max(2000), detached: z.boolean() }).strict(),
  messages: z.array(z.object({ id, body: z.string().min(1).max(2000) }).strict()).min(1).max(50),
}).strict()
export const storedCommentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('canvas'), thread: canvasThreadSchema }).strict(),
  z.object({ kind: z.literal('document'), thread: textThreadSchema }).strict(),
])
export type StoredComment = z.infer<typeof storedCommentSchema>
export const workspaceBackupSchema = z.object({
  version: z.literal(1),
  conversations: z.array(z.object({
    title: z.string().min(1).max(200),
    artifacts: z.array(z.object({ artifact: openArtifactSchema, comments: z.array(storedCommentSchema).max(100) }).strict()).max(100),
    messages: z.array(workspaceMessageSchema).max(10000),
  }).strict()).max(1000),
}).strict()
export type WorkspaceBackup = z.infer<typeof workspaceBackupSchema>
export class WorkspaceError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}
