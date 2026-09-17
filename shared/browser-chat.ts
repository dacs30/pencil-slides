import { z } from 'zod'
import { artifactInfoSchema } from './browser-storage.js'
const id = z.string().min(1).max(120)
export const browserHandoffSchema = z.object({
  artifactId: id, kind: z.enum(['slides', 'document', 'page']), threadId: id, version: z.number().int().positive(),
  anchor: z.union([
    z.object({ kind: z.enum(['point', 'object']), slideId: id, nodeId: id.optional(), x: z.number().finite(), y: z.number().finite() }).strict(),
    z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), quote: z.string().max(2000), detached: z.boolean() }).strict(),
  ]),
  detached: z.enum(['object_deleted', 'object_moved', 'slide_deleted', 'text_deleted']).nullable(),
  messages: z.array(z.string().max(2000)).min(1).max(10), truncated: z.boolean(),
}).strict().refine(v => (v.kind === 'document') === ('from' in v.anchor), 'Comment anchor does not match its artifact type.')
export const browserChatSchema = z.object({
  message: z.string().trim().min(1).max(12000), artifactId: id.optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(60000) }).strict()).max(40),
  artifacts: z.array(artifactInfoSchema).max(100),
  handoff: browserHandoffSchema.optional(),
}).strict().superRefine((input, ctx) => {
  const ids = new Set(input.artifacts.map(a => a.id))
  if (ids.size !== input.artifacts.length) ctx.addIssue({ code: 'custom', message: 'Duplicate artifact IDs in context.' })
  if (input.artifactId && !ids.has(input.artifactId)) ctx.addIssue({ code: 'custom', message: 'Active artifact is not in this workspace context.' })
  if (input.history.reduce((sum, m) => sum + m.content.length, 0) > 120000) ctx.addIssue({ code: 'custom', message: 'Chat context exceeds its size limit.' })
  if (input.handoff && (input.handoff.artifactId !== input.artifactId || input.artifacts.find(a => a.id === input.handoff!.artifactId)?.kind !== input.handoff.kind)) ctx.addIssue({ code: 'custom', message: 'Comment belongs to a different artifact.' })
  if (input.handoff?.detached === 'slide_deleted') ctx.addIssue({ code: 'custom', message: 'The comment artboard was deleted.' })
})
export type BrowserChatRequest = z.infer<typeof browserChatSchema>
