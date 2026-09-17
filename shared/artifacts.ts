import { z } from 'zod'
import type { Deck, Command, ToolResult } from './model.js'
import { batchSchema, operationSchema } from './model.js'
import { textBatchSchema, textOperationSchema, type TextSnapshot } from './rich-text.js'
import { pageBatchSchema, pageOperationSchema, type PageArtifact } from './page.js'

export type ArtifactKind = 'slides' | 'document' | 'page'
export type ArtifactInfo = { id: string; kind: ArtifactKind; title: string; revision: number }
export type TextDocument = { id: string; revision: number; snapshot: TextSnapshot }
export type OpenArtifact = { kind: 'slides'; value: Deck } | { kind: 'document'; value: TextDocument } | { kind: 'page'; value: PageArtifact }
export type Conversation = { id: string; title: string; artifacts: ArtifactInfo[] }
export type ArtifactCardData = ArtifactInfo
export type WorkspaceMessage = {
  role: 'user' | 'assistant'; content: string
  runState?: 'running' | 'complete' | 'interrupted'
  activities?: import('./chat.js').ToolActivity[]
  artifacts?: ArtifactCardData[]
}
export function upsertArtifactCard(cards: ArtifactCardData[], artifact: ArtifactCardData) {
  const existing = cards.find(card => card.id === artifact.id)
  if (!existing) cards.push({ ...artifact })
  else if (artifact.revision >= existing.revision) Object.assign(existing, artifact)
}
export function normalizeArtifactCards(message: WorkspaceMessage): WorkspaceMessage {
  if (!message.artifacts) return message
  const artifacts: ArtifactCardData[] = []
  for (const artifact of message.artifacts) upsertArtifactCard(artifacts, artifact)
  return { ...message, artifacts }
}
export function restoreWorkspaceMessage(message: WorkspaceMessage): WorkspaceMessage {
  const restored = normalizeArtifactCards(message)
  if (restored.role !== 'assistant' || restored.runState !== 'running' && !restored.activities?.some(a => a.status === 'running')) return restored
  const error = 'This run is not active in this tab. Check the saved artifacts before continuing.'
  return {
    ...restored, runState: 'interrupted', content: restored.content || error,
    activities: restored.activities?.map(activity => activity.status === 'running' ? { ...activity, status: 'interrupted', error } : activity),
  }
}
export type ArtifactCommand = { id: string; name: string; input: unknown }
export type ArtifactAdapter = {
  flush: () => Promise<void>
  execute: (command: Command) => Promise<ToolResult>
  context: () => unknown
}
export const artifactId = z.string().min(1).max(120)
export const createArtifactSchema = z.object({ kind: z.enum(['slides', 'document', 'page']), title: z.string().trim().min(1).max(200) }).strict()
export const artifactReadSchema = z.object({
  artifactId: artifactId.optional(), view: z.enum(['workspace', 'deck', 'slide', 'selection', 'document', 'page']),
  slideId: artifactId.optional(),
}).strict()
export const artifactBatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slides'), artifactId, ...batchSchema.shape }).strict(),
  z.object({ kind: z.literal('document'), artifactId, ...textBatchSchema.shape }).strict(),
  z.object({ kind: z.literal('page'), artifactId, ...pageBatchSchema.shape }).strict(),
])
// Publish one required array; runtime validation still enforces each artifact's operation family.
export const artifactBatchToolSchema = z.object({
  kind: z.enum(['slides', 'document', 'page']), artifactId,
  expectedRevision: batchSchema.shape.expectedRevision,
  operations: z.array(z.discriminatedUnion('op', [
    ...operationSchema.options, ...textOperationSchema.options, ...pageOperationSchema.options,
  ])).min(1).max(100).describe('Required top-level array of edits. Send small batches, preferably no more than 8 operations, and wait for each result before sending the next batch.'),
}).strict()
export function validateArtifactTool(name: string, input: unknown) {
  if (name === 'read_context') return artifactReadSchema.parse(input)
  if (name === 'apply_batch') return artifactBatchSchema.parse(input)
  if (name === 'create_artifact') return createArtifactSchema.parse(input)
  throw new Error('Unsupported tool.')
}
