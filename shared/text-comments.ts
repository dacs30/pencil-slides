import { z } from 'zod'
import type { TextAnchor } from './rich-text.js'
export type TextThread = {
  id: string; documentId: string; anchor: TextAnchor; version: number; resolved: boolean
  messages: { id: string; body: string }[]
}
export const textCommentSchema = z.object({
  id: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  from: z.number().int().nonnegative(), to: z.number().int().positive(),
  body: z.string().trim().min(1).max(2000),
}).strict()
